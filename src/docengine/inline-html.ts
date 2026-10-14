import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";

import { abbreviate } from "./css-rules.js";
import { textNode, type DocNode } from "./model.js";
import { documentLink } from "./safe-urls.js";
import { escapeAttribute, escapeText } from "./xml.js";

/*
 * Reads a node's `html` string (doc-rules.md §5): inline formatting only, e.g. "Cut latency by <b>40%</b>".
 * htmlparser2 parses it leniently like a browser would; we then keep only allowlisted inline tags and the
 * href/title of links, turning the result into nodes. Nothing from the string is printed as-is: the writer escapes
 * every text run and attribute again.
 */

export const INLINE_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "sub", "sup", "small", "mark", "code",
  "span", "a", "br"]);

/** Dropped with their content (never unwrapped: their text isn't document text). */
const DANGEROUS = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "noscript",
  "template", "svg", "math", "img", "picture", "video", "audio", "source", "track", "canvas", "link", "meta", "base",
  "form", "input", "button", "select", "option", "textarea"]);

export type InlineProblem = { code: string; message: string };
export type InlineResult = { nodes: DocNode[]; html: string; problems: InlineProblem[] };

export function parseInlineHtml(html: string): InlineResult {
  const problems: InlineProblem[] = [];
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const nodes = children(document.children, problems, false);
  return { nodes, html: inlineToHtml(nodes), problems };
}

function children(nodes: ChildNode[], problems: InlineProblem[], insideLink: boolean): DocNode[] {
  const out: DocNode[] = [];
  for (const child of nodes) {
    if (isText(child)) {
      if (child.data) out.push(textNode(child.data));
    } else if (isTag(child)) {
      // Elements, including <script> and <style> (which are dropped with their content)
      out.push(...element(child, problems, insideLink));
    }
    // Comments, doctypes and processing instructions are ignored
  }
  return out;
}

function element(el: Element, problems: InlineProblem[], insideLink: boolean): DocNode[] {
  const tag = el.name.toLowerCase();
  if (DANGEROUS.has(tag)) {
    problems.push({ code: "INLINE_TAG_NOT_ALLOWED", message: `<${tag}> isn't allowed in html; it was removed.` });
    return [];
  }
  if (!INLINE_TAGS.has(tag) || (insideLink && tag === "a")) {
    problems.push({
      code: "INLINE_TAG_NOT_ALLOWED",
      message: `<${tag}> isn't allowed in html (only ${[...INLINE_TAGS].sort().join(", ")}); its text was kept.`,
    });
    return children(el.children, problems, insideLink);
  }

  const attrs: Record<string, string> = {};
  const link = tag === "a";
  for (const [rawKey, value] of Object.entries(el.attribs)) {
    const key = rawKey.toLowerCase();
    if (link && key === "href") {
      const safe = documentLink(value);
      if (safe) {
        attrs.href = safe;
      } else {
        problems.push({
          code: "UNSAFE_LINK",
          message: `Link "${abbreviate(value)}" isn't allowed (only https, http, mailto and tel); it's shown as text.`,
        });
      }
    } else if (link && key === "title" && value.length <= 200) {
      attrs.title = value;
    } else {
      problems.push({
        code: "INLINE_ATTR_NOT_ALLOWED",
        message: `Attribute "${key}" on <${tag}> isn't allowed in html; style it with JSON instead. It was removed.`,
      });
    }
  }
  if (link && !attrs.href) {
    // A link without a usable address is just text
    return [{ ...textNode(""), tag: "span", text: null, children: children(el.children, problems, true) }];
  }
  const kids = tag === "br" ? [] : children(el.children, problems, insideLink || link);
  return [{ ...textNode(""), tag, text: null, attrs, children: kids }];
}

/** The sanitized nodes written back as an html string (for documents returned by lenient validation). */
export function inlineToHtml(nodes: DocNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.tag === "#text") {
      out += escapeText(node.text);
      continue;
    }
    out += `<${node.tag}`;
    for (const [key, value] of Object.entries(node.attrs)) out += ` ${key}="${escapeAttribute(value)}"`;
    if (node.tag === "br") {
      out += ">";
      continue;
    }
    out += `>${inlineToHtml(node.children)}</${node.tag}>`;
  }
  return out;
}
