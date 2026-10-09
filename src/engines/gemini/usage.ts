import { TranslationSettingsChangedError } from '../../core/errors';
import { redact } from '../../core/redact';
import type { Attempt, FailureKind } from '../types';
import type { ModelConfig } from './config';
import { PAUSE_REASONS, record } from './errors';

export const API_KEY = 'geminiApiKey';
export const REVISION_KEY = 'geminiConfigRevision';
export const USAGE_KEY = 'geminiUsage';
export const PAUSE_KEY = 'geminiPause';
export const AVAILABILITY_KEY = 'geminiModelAvailability';
export interface LocalStorage {
	get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}
export interface KeySession {
	key: string;
	hash: string;
	revision: string;
}
interface MinuteEntry {
	id: string;
	at: number;
	tokens: number;
}
export interface ModelUsage {
	day: string;
	requests: number;
	minute: MinuteEntry[];
	blockedUntil: number;
	blockReason?: FailureKind;
}
export interface ModelAvailability {
	attempt: Attempt;
	disabledAt: number;
	retryAt?: number;
}
const formatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'America/Los_Angeles',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});
export function pacificDay(time: number): string {
	const parts = formatter.formatToParts(time);
	return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
}
export function nextPacificMidnight(time: number): number {
	const day = pacificDay(time);
	let low = Math.floor(time / 1000);
	let high = low + 90_000;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (pacificDay(middle * 1000) === day) low = middle;
		else high = middle;
	}
	return high * 1000;
}
export async function keyHash(key: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function nonnegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function restoredAttempt(value: unknown, reasons: ReadonlySet<FailureKind>): Attempt | undefined {
	const item = record(value);
	if (!reasons.has(item.reason as FailureKind)) return;
	return {
		sent: false,
		reason: item.reason as FailureKind,
		...(typeof item.model === 'string' ? { model: item.model } : {}),
		...(typeof item.httpStatus === 'number' ? { httpStatus: item.httpStatus } : {}),
		...(typeof item.providerReason === 'string' ? { providerReason: redact(item.providerReason) } : {}),
		...(typeof item.providerMessage === 'string' ? { providerMessage: redact(item.providerMessage) } : {}),
	};
}
export class GeminiStore {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		public readonly storage: LocalStorage = chrome.storage.local,
		public readonly now = Date.now,
	) {}
	private update<T>(work: (data: Record<string, unknown>) => Promise<T>): Promise<T> {
		const pending = this.queue.then(async () => work(await this.storage.get(null)));
		this.queue = pending.catch(() => {});
		return pending;
	}
	async session(): Promise<KeySession> {
		const data = await this.storage.get([API_KEY, REVISION_KEY]);
		const key = typeof data[API_KEY] === 'string' ? data[API_KEY].trim() : '';
		return {
			key,
			hash: await keyHash(key),
			revision: typeof data[REVISION_KEY] === 'string' ? data[REVISION_KEY] : '',
		};
	}
	private matches(data: Record<string, unknown>, session: KeySession): boolean {
		return data[API_KEY] === session.key && (data[REVISION_KEY] ?? '') === session.revision;
	}
	async current(session: KeySession): Promise<boolean> {
		return this.matches(await this.storage.get([API_KEY, REVISION_KEY]), session);
	}
	async pause(session: KeySession): Promise<Attempt | undefined> {
		const data = await this.storage.get([PAUSE_KEY]);
		const pause = record(data[PAUSE_KEY]);
		return pause.keyHash === session.hash ? restoredAttempt(pause.attempt, PAUSE_REASONS) : undefined;
	}
	async recoverPause(session: KeySession, signal?: AbortSignal): Promise<boolean> {
		return this.update(async (data) => {
			if (signal?.aborted || !this.matches(data, session) || record(data[PAUSE_KEY]).keyHash !== session.hash)
				return false;
			await this.storage.remove(PAUSE_KEY);
			return true;
		});
	}
	usage(value: unknown, time = this.now()): ModelUsage {
		const data = record(value);
		const day = pacificDay(time);
		const minute = (Array.isArray(data.minute) ? data.minute : [])
			.map(record)
			.filter(
				(item) =>
					typeof item.id === 'string' &&
					nonnegative(item.at) &&
					item.at > time - 60_000 &&
					item.at <= time &&
					nonnegative(item.tokens),
			)
			.map((item) => ({ id: item.id as string, at: item.at as number, tokens: item.tokens as number }));
		return {
			day,
			requests:
				data.day === day && Number.isSafeInteger(data.requests) && nonnegative(data.requests) ? data.requests : 0,
			minute,
			blockedUntil: nonnegative(data.blockedUntil) ? data.blockedUntil : 0,
			...(['quota-day', 'quota-minute', 'service', 'network', 'timeout'].includes(String(data.blockReason))
				? { blockReason: data.blockReason as FailureKind }
				: {}),
		};
	}
	availability(value: unknown): ModelAvailability | undefined {
		const data = record(value);
		const attempt = restoredAttempt(data.attempt, new Set(['model-access-denied', 'model-missing']));
		if (!attempt || !nonnegative(data.disabledAt)) return;
		if (attempt.reason === 'model-access-denied' && (!nonnegative(data.retryAt) || data.retryAt <= this.now())) return;
		return { attempt, disabledAt: data.disabledAt, ...(nonnegative(data.retryAt) ? { retryAt: data.retryAt } : {}) };
	}
	async snapshot(
		session: KeySession,
	): Promise<{ usage: Record<string, ModelUsage>; availability: Record<string, ModelAvailability> }> {
		const data = await this.storage.get([USAGE_KEY, AVAILABILITY_KEY]);
		const availability: Record<string, ModelAvailability> = {};
		for (const [id, value] of Object.entries(record(data[AVAILABILITY_KEY])))
			if (id.startsWith(session.hash + ':')) {
				const item = this.availability(value);
				if (item) availability[id.slice(session.hash.length + 1)] = item;
			}
		return {
			usage: Object.fromEntries(Object.entries(record(data[USAGE_KEY])).map(([id, value]) => [id, this.usage(value)])),
			availability,
		};
	}
	async skipped(session: KeySession, model: ModelConfig, estimate: number): Promise<Attempt | undefined> {
		if (model.rpm === 0 || model.tpm === 0 || model.rpd === 0)
			return { model: model.id, sent: false, reason: 'disabled' };
		const state = await this.snapshot(session);
		if (state.availability[model.id]) return { ...state.availability[model.id]!.attempt, model: model.id, sent: false };
		const usage = state.usage[model.id] ?? this.usage(undefined);
		let reason: FailureKind | undefined;
		if (usage.requests >= model.rpd) reason = 'quota-day';
		else if (
			usage.minute.length >= model.rpm ||
			usage.minute.reduce((sum, entry) => sum + entry.tokens, 0) + estimate > model.tpm
		)
			reason = 'quota-minute';
		else if (usage.blockedUntil > this.now()) reason = usage.blockReason ?? 'quota-minute';
		return reason ? { model: model.id, sent: false, reason } : undefined;
	}
	async sent(session: KeySession, model: string, tokens: number, draftProbe = false): Promise<string> {
		return this.update(async (data) => {
			if (!draftProbe && !this.matches(data, session)) throw new TranslationSettingsChangedError();
			const all = record(data[USAGE_KEY]);
			const usage = this.usage(all[model]);
			const id = crypto.randomUUID();
			usage.requests++;
			usage.minute.push({ id, at: this.now(), tokens });
			await this.storage.set({ [USAGE_KEY]: { ...all, [model]: usage } });
			return id;
		});
	}
	async tokens(model: string, id: string, tokens: number): Promise<void> {
		if (!Number.isSafeInteger(tokens) || tokens < 0) return;
		await this.update(async (data) => {
			const all = record(data[USAGE_KEY]);
			const usage = this.usage(all[model]);
			const entry = usage.minute.find((item) => item.id === id);
			if (entry) {
				entry.tokens = tokens;
				await this.storage.set({ [USAGE_KEY]: { ...all, [model]: usage } });
			}
		});
	}
	async failed(session: KeySession, attempt: Attempt, cooldown = false, signal?: AbortSignal): Promise<void> {
		await this.update(async (data) => {
			if (signal?.aborted || !this.matches(data, session)) return;
			if (PAUSE_REASONS.has(attempt.reason)) {
				await this.storage.set({ [PAUSE_KEY]: { keyHash: session.hash, attempt: { ...attempt, sent: false } } });
				return;
			}
			if (!attempt.model) return;
			if (attempt.reason === 'model-access-denied' || attempt.reason === 'model-missing') {
				await this.storage.set({
					[AVAILABILITY_KEY]: {
						...record(data[AVAILABILITY_KEY]),
						[`${session.hash}:${attempt.model}`]: {
							attempt: { ...attempt, sent: false },
							disabledAt: this.now(),
							...(attempt.reason === 'model-access-denied' ? { retryAt: nextPacificMidnight(this.now()) } : {}),
						},
					},
				});
				return;
			}
			if (attempt.reason === 'quota-day' || attempt.reason === 'quota-minute' || cooldown) {
				const all = record(data[USAGE_KEY]);
				const usage = this.usage(all[attempt.model]);
				usage.blockedUntil =
					attempt.reason === 'quota-day'
						? nextPacificMidnight(this.now())
						: this.now() + (attempt.reason === 'quota-minute' ? (attempt.retryMs ?? 60_000) : 30_000);
				usage.blockReason = attempt.reason;
				await this.storage.set({ [USAGE_KEY]: { ...all, [attempt.model]: usage } });
			}
		});
	}
	async recoverModel(session: KeySession, model: string, signal?: AbortSignal): Promise<boolean> {
		return this.update(async (data) => {
			if (signal?.aborted || !this.matches(data, session)) return false;
			const all = { ...record(data[AVAILABILITY_KEY]) };
			const id = `${session.hash}:${model}`;
			if (!all[id]) return false;
			delete all[id];
			await this.storage.set({ [AVAILABILITY_KEY]: all });
			return true;
		});
	}
}
