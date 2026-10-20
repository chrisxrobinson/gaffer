// The Markdown the text answers use (the /whatif, /explain and /chips templates ask for plain text and a small table):
// paragraphs, lists, bold and tables, plus headings shown as bold lines and `code` as text. It builds Preact elements
// from the text, so whatever the model wrote stays text: no innerHTML, no links, no images, no raw HTML.
import { h } from "preact";

/** **bold** and `code` within a line; everything else is text. */
function inline(text, key = "") {
	const out = [];
	const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;
	let last = 0;
	let m;
	let n = 0;
	while ((m = re.exec(text))) {
		if (m.index > last) out.push(text.slice(last, m.index));
		out.push(m[3] !== undefined ? h("code", { key: `${key}c${n++}` }, m[3]) : h("strong", { key: `${key}b${n++}` }, m[1] ?? m[2]));
		last = re.lastIndex;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;
const numeric = (c) => /^([−+-]?[£$]?\d[\d.,]*\s*(m|%|xP|pts)?|[–—-])$/.test(c.trim());

/** Blocks from Markdown text: a list of Preact elements. Unfinished text (still streaming) renders as it stands. */
export function markdown(text) {
	const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	let i = 0;
	let k = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		// A table: a header row, a rule, then rows.
		if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
			const head = cells(line);
			const rows = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
			// A column of figures (a dash for none) is right-aligned, as the App's own tables are.
			const right = head.map((_, c) => rows.some((r) => r[c] && /\d/.test(r[c])) && rows.every((r) => !r[c] || numeric(r[c])));
			out.push(h("div", { class: "scroll-x", tabindex: 0, role: "region", "aria-label": "Table", key: k++ }, h("table", { class: "md" },
				h("thead", null, h("tr", null, head.map((c, j) => h("th", { key: j, class: right[j] ? "n" : undefined }, inline(c, `h${j}`))))),
				h("tbody", null, rows.map((r, ri) => h("tr", { key: ri }, head.map((_, j) => h("td", { key: j, class: right[j] ? "n" : undefined }, inline(r[j] ?? "", `${ri}-${j}`)))))))));
			continue;
		}
		const list = LIST.exec(line);
		if (list) {
			const ordered = list[1] !== undefined;
			const items = [];
			while (i < lines.length) {
				const m = LIST.exec(lines[i]);
				if (m && (m[1] !== undefined) === ordered) items.push(m[2]);
				else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
				else break;
				i++;
			}
			out.push(h(ordered ? "ol" : "ul", { key: k++ }, items.map((t, j) => h("li", { key: j }, inline(t, `l${j}`)))));
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			out.push(h("p", { class: "md-h", key: k++ }, h("strong", null, inline(heading[1].replace(/\*\*/g, "")))));
			i++;
			continue;
		}
		// A paragraph: lines up to a blank one or the start of another block.
		const para = [];
		while (i < lines.length && lines[i].trim() && !LIST.exec(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++].trim());
		out.push(h("p", { key: k++ }, inline(para.join(" "))));
	}
	return out;
}
