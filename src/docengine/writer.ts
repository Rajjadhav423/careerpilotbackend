import { pageSizeCss, type Doc, type DocNode, type StyleMap } from "./model.js";
import { escapeAttribute, escapeText } from "./xml.js";

/*
 * Writes a validated Doc as XHTML with its CSS inlined. The same markup is printed to PDF and shown in browser
 * previews.
 *
 * Cascade (doc-rules.md §3): engine defaults → preset styles → document styles → the node's own style.
 * Everything printed comes from the reader: tags, attributes and CSS are allowlisted and every text and attribute
 * value is escaped here, so a document can't inject markup, scripts or resource loads.
 */

const ENGINE_CSS = `html { color: #1f2328; }
body { margin: 0; font-family: "Inter"; font-size: 10pt; line-height: 1.38; }
h1, h2, h3, h4, h5, h6, p, ul, ol, dl, dd, blockquote, pre, address, figure { margin: 0; }
h1 { font-size: 20pt; font-weight: 700; }
h2 { font-size: 12pt; font-weight: 700; }
h3 { font-size: 10.5pt; font-weight: 700; }
h4, h5, h6 { font-size: 10pt; font-weight: 700; }
h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
a { color: inherit; text-decoration: none; }
ul, ol { padding-left: 13pt; }
li { margin: 1.5pt 0; }
p, li { orphans: 2; widows: 2; }
strong, b { font-weight: 700; }
em, i { font-style: italic; }
blockquote { padding-left: 8pt; border-left: 1.5pt solid #c1c7d0; }
pre { white-space: pre-wrap; }
hr { border: 0; border-top: 0.75pt solid #c1c7d0; margin: 4pt 0; }
table { border-collapse: collapse; width: 100%; }
td, th { vertical-align: top; text-align: left; padding: 0; }
h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, address, blockquote { word-wrap: break-word; }
`;

const defaultLabel = (doc: Doc) => (doc.document === "coverLetter" ? "Cover letter" : "Resume");

/** presetStyles: the styles of the document's preset (empty when it has none). */
export function toXhtml(doc: Doc, presetStyles: Record<string, StyleMap>): string {
  let out = `<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeAttribute(doc.meta.language)}"`
    + ` class="page-${pageSizeCss(doc.page.size)}">\n<head>\n<meta charset="UTF-8" />\n`;
  out += `<title>${escapeText(doc.meta.title ?? defaultLabel(doc))}</title>\n`;
  if (doc.meta.author != null) out += `<meta name="author" content="${escapeAttribute(doc.meta.author)}" />\n`;
  out += `<meta name="subject" content="${escapeAttribute(doc.meta.subject ?? defaultLabel(doc))}" />\n`;
  out += `<style>\n${css(doc, presetStyles)}</style>\n</head>\n<body>\n`;
  for (const section of doc.sections) {
    if (!section.visible) continue;
    out += `<section id="${escapeAttribute(section.id)}" class="section"${styleAttribute(section.style)}>\n`;
    for (const node of section.nodes) out += `${writeNode(node, false)}\n`;
    out += "</section>\n";
  }
  return `${out}</body>\n</html>\n`;
}

export function css(doc: Doc, presetStyles: Record<string, StyleMap>): string {
  let css = `@page {\n  size: ${pageSizeCss(doc.page.size)};\n  margin: ${doc.page.margin};\n`;
  if (doc.page.pageNumbers) {
    css += `  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-family: "Inter";
    font-size: 7.5pt;
    color: #6b6e76;
  }
`;
  }
  css += `}\n${ENGINE_CSS}`;
  css += rules(presetStyles);
  css += rules(doc.styles);
  // Browser preview: a paper sheet with the page margins as padding; phones reflow
  const letter = doc.page.size === "LETTER";
  css += `@media screen {\n  html { background: #e9ebee; }\n  body { box-sizing: border-box; width: ${letter ? "215.9mm" : "210mm"};`
    + ` min-height: ${letter ? "279.4mm" : "297mm"}; margin: 24px auto; padding: ${doc.page.margin};`
    + " background: #ffffff; box-shadow: 0 1px 4px rgba(9, 30, 66, 0.25); }\n}\n"
    + "@media screen and (max-width: 860px) {\n  html { background: #ffffff; }\n"
    + "  body { width: auto; min-height: 0; margin: 0; padding: 16px; box-shadow: none; }\n}\n";
  return css;
}

function rules(styles: Record<string, StyleMap>) {
  let css = "";
  for (const [selector, style] of Object.entries(styles)) {
    if (Object.keys(style).length === 0) continue;
    css += `${selector} { ${declarations(style)} }\n`;
  }
  return css;
}

const declarations = (style: StyleMap) =>
  Object.entries(style).map(([property, value]) => `${property}: ${value};`).join(" ");

const styleAttribute = (style: StyleMap) =>
  Object.keys(style).length > 0 ? ` style="${escapeAttribute(declarations(style))}"` : "";

function writeNode(node: DocNode, preformatted: boolean): string {
  if (node.tag === "#text") return text(node.text ?? "", preformatted);
  if (!node.visible) return "";
  const tag = node.tag;
  let out = `<${tag}`;
  if (node.id != null) out += ` id="${escapeAttribute(node.id)}"`;
  if (node.classes.length > 0) out += ` class="${escapeAttribute(node.classes.join(" "))}"`;
  out += styleAttribute(node.style);
  if (node.role != null) out += ` data-role="${escapeAttribute(node.role)}"`;
  for (const [name, value] of Object.entries(node.attrs)) out += ` ${name}="${escapeAttribute(value)}"`;
  if (tag === "a" && node.attrs.title === undefined) {
    // Accessible name for the PDF link annotation: the link's own text
    const label = plainText(node).trim();
    if (label) out += ` title="${escapeAttribute(label.slice(0, 200))}"`;
  }
  if (tag === "br" || tag === "hr") return `${out} />`;
  out += ">";
  const pre = preformatted || tag === "pre";
  if (node.text != null) out += text(node.text, pre);
  for (const child of node.children) out += writeNode(child, pre);
  return `${out}</${tag}>`;
}

function plainText(node: DocNode): string {
  return node.text ?? node.children.map(plainText).join("");
}

/** Escaped text; line breaks become <br /> (kept as newlines inside <pre>). */
function text(value: string, preformatted: boolean) {
  const escaped = escapeText(value);
  return preformatted ? escaped : escaped.replaceAll("\r\n", "\n").replaceAll("\n", "<br />");
}
