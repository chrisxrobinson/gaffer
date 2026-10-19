// htm bound to Preact: JSX-like templates with no build step. Text in ${…} is always rendered as text, never as HTML.
import { h } from "preact";
import htm from "htm";

export const html = htm.bind(h);
