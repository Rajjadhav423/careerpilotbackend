import { webLink } from "../docengine/safe-urls.js";

/*
 * The tiny formatting language allowed inside resume text: **bold**, *italic* (or _italic_) and [label](https://…).
 * Anything else is printed literally; a backslash escapes a marker (\*). No nesting, no HTML: the output is built here
 * with every character escaped, and links only survive if webLink accepts them (otherwise just the label is printed).
 * The result can contain only <strong>, <em> and <a href> tags created here.
 */

const isWhitespace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isLetterOrDigit = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Safe XHTML for one line or paragraph of resume text. */
export function richTextToXhtml(text: string | null | undefined): string {
  if (!text) return "";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && "*_[]()\\".includes(text[i + 1]!)) {
      out += escape(text[i + 1]!);
      i += 2;
      continue;
    }
    if (c === "*" && text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        out += `<strong>${escape(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && i + 1 < text.length && !isWhitespace(text[i + 1])) {
      const end = text.indexOf(c, i + 1);
      // "_" only counts at word boundaries, so snake_case words stay intact
      const boundary = c === "*" || ((i === 0 || !isLetterOrDigit(text[i - 1]))
        && (end + 1 >= text.length || !isLetterOrDigit(text[end + 1])));
      if (end > i + 1 && boundary && !isWhitespace(text[end - 1])) {
        out += `<em>${escape(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close < 0 ? -1 : closingParen(text, close + 2);
      if (close > i + 1 && end > close + 2) {
        const label = text.slice(i + 1, close);
        const safe = webLink(text.slice(close + 2, end));
        out += safe ? `<a href="${escape(safe)}">${escape(label)}</a>` : escape(label);
        i = end + 1;
        continue;
      }
    }
    out += escape(c);
    i++;
  }
  return out;
}

/** Plain text without markers (used for diffs and summaries). */
export function richTextToPlain(text: string | null | undefined): string | null {
  if (text == null) return null;
  return richTextToXhtml(text).replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

/** Splits text into paragraphs at blank lines and formats each one. */
export function richTextParagraphs(text: string | null | undefined): string[] {
  if (text == null) return [];
  return text.split(/\n\s*\n/)
    .map((paragraph) => paragraph.replaceAll("\n", " ").trim())
    .filter(Boolean)
    .map(richTextToXhtml);
}

/** Index of the ")" that closes a link target starting at `from`, allowing balanced parentheses inside. */
function closingParen(text: string, from: number) {
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return j;
      depth--;
    } else if (isWhitespace(c)) return -1;
  }
  return -1;
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}
