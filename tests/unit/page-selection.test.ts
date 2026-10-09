import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { readPageSelection, selectionPayload, type SelectionBrowser } from "../../src/core/page-selection";

function browser(text: unknown = "Selected text.\n\nA second paragraph.") {
  const queries: unknown[] = [];
  const injections: unknown[] = [];
  const api: SelectionBrowser = {
    tabs: { async query(options) { queries.push(options); return [{ id: 42, url: "https://example.com/article" }]; } },
    scripting: { async executeScript(options) { injections.push(options); return [{ result: text }]; } },
  };
  return { api, queries, injections };
}

test("popup reads the active page once, preserving selected text and paragraph breaks", async () => {
  const b = browser();
  expect(await readPageSelection(undefined, b.api)).toEqual({ text: "Selected text.\n\nA second paragraph." });
  expect(b.queries).toEqual([{ active: true, currentWindow: true }]);
  expect(b.injections).toHaveLength(1);
  expect(b.injections[0]).toMatchObject({ target: { tabId: 42 }, func: expect.any(Function) });
});

test("keyboard commands read their supplied tab without querying a different active tab", async () => {
  const b = browser();
  expect(await readPageSelection({ id: 7, url: "https://example.org" }, b.api)).toHaveProperty("text");
  expect(b.queries).toEqual([]);
  expect(b.injections[0]).toMatchObject({ target: { tabId: 7 } });
});

test("context-menu reads target the clicked frame and preserve its paragraphs", async () => {
  const b = browser();
  expect(await readPageSelection({ id: 7, url: "https://example.org" }, b.api, 12)).toEqual({ text: "Selected text.\n\nA second paragraph." });
  expect(b.injections[0]).toMatchObject({ target: { tabId: 7, frameIds: [12] } });
  expect(b.queries).toEqual([]);
});

test.each(["chrome://settings", "edge://extensions", "https://chromewebstore.google.com/detail/test", "file:///test", "chrome-extension://test/popup.html"])("does not inject into restricted page %s", async url => {
  const b = browser();
  expect(await readPageSelection({ id: 42, url }, b.api)).toEqual({ error: "restricted" });
  expect(b.injections).toEqual([]);
});

test("handles missing active tabs without attempting injection", async () => {
  const b = browser(); b.api.tabs.query = async () => [];
  expect(await readPageSelection(undefined, b.api)).toEqual({ error: "restricted" });
  expect(b.injections).toEqual([]);
});

test("selection-query and page-access failures return a fallback instead of rejecting", async () => {
  const b = browser(); b.api.tabs.query = async () => { throw new Error("Window closed"); };
  expect(await readPageSelection(undefined, b.api)).toEqual({ error: "unavailable" });
  b.api.scripting.executeScript = async () => { throw new Error("Access denied"); };
  expect(await readPageSelection({ id: 42, url: "https://example.com" }, b.api)).toEqual({ error: "unavailable" });
});

test("empty, invalid, and missing injection results leave no text to auto-translate", async () => {
  for (const value of ["", " \n ", undefined, null, 42, { text: "untrusted object" }]) {
    const b = browser(); b.api.scripting.executeScript = async () => [{ result: value }];
    expect(await readPageSelection(undefined, b.api)).toEqual({ error: "empty" });
  }
  const b = browser(); b.api.scripting.executeScript = async () => [];
  expect(await readPageSelection(undefined, b.api)).toEqual({ error: "empty" });
});

test("oversized selections are rejected without truncating or returning their contents", async () => {
  const b = browser("a".repeat(4001));
  expect(await readPageSelection(undefined, b.api)).toEqual({ error: "too-long" });
  expect(selectionPayload("a".repeat(4000))).toEqual({ text: "a".repeat(4000) });
  expect(selectionPayload("  Original text.\n ")).toEqual({ text: "  Original text.\n " });
});

test("password selections do not send masked characters to detection or read the field value", async () => {
  class Input {
    type = "password";
    get value(): never { throw new Error("Must not read a password field"); }
  }
  const b = browser();
  b.api.scripting.executeScript = async ({ func }) => [{ result: runInNewContext(`(${func.toString()})()`, {
    document: { activeElement: new Input() },
    HTMLInputElement: Input,
    HTMLTextAreaElement: class {},
    window: { getSelection: () => ({ toString: () => "••••" }) },
  }) }];
  expect(await readPageSelection(undefined, b.api)).toEqual({ error: "empty" });
});
