import { render } from "solid-js/web";
import { TranslatorApp } from "../ui/TranslatorApp";
import "../ui/styles.css";
render(() => <TranslatorApp selection/>, document.getElementById("root")!);
