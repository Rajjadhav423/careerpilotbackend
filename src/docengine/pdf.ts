import path from "node:path";

import { Document, Font, Link, Page, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createElement, type ReactElement, type ReactNode } from "react";

import { ApiError } from "../http/errors.js";
import { parseColor } from "./css-rules.js";
import { FONT_FILES, FONTS_DIR, resolveFont } from "./fonts.js";
import type { Doc, DocNode, StyleMap } from "./model.js";
import { CONTAINERS, INLINE, TEXT_BLOCKS } from "./reader.js";
import { clean } from "./xml.js";

/*
 * Prints a validated document to PDF with @react-pdf/renderer: pure JavaScript, no browser, low memory.
 *
 * The document model (already checked by the reader) becomes react-pdf elements: blocks are <View>s, text blocks
 * and inline formatting are nested <Text>s, links are <Link>s. CSS from the cascade (engine defaults → preset →
 * document styles → the node's own style) is converted to react-pdf styles. react-pdf lays out with flexbox, so:
 *   - display: table / table-row (and <tr>) become rows; table cells share the width, a cell with a width keeps it,
 *     and a "nowrap" cell (like entry dates) takes only the room it needs
 *   - float: left/right puts that child at the start/end of a row next to the rest of the content
 *   - page-break-inside: avoid keeps a block on one page; page-break-before/after: always break the page;
 *     page-break-after: avoid and -fs-page-break-min-height keep a heading with what follows
 * Fonts are the bundled OFL fonts, embedded so text stays selectable and readable by applicant tracking systems.
 * Nothing is fetched: links are only written as annotations.
 */

export type RenderedPdf = { bytes: Buffer; pages: number };

export type PdfLimits = {
  maxPages: number;
  maxBytes: number;
  renderTimeoutMs: number;
  maxConcurrent: number;
  maxQueued: number;
};

/** The PDF step, replaceable in tests. */
export interface PdfRenderer {
  render(doc: Doc, presetStyles: Record<string, StyleMap>): Promise<RenderedPdf>;
  close(): Promise<void>;
}

const busy = () => new ApiError(503, "DOCUMENT_BUSY",
  "Lots of documents are being created right now. Please try again in a moment.");
const timedOut = () => new ApiError(503, "DOCUMENT_TIMEOUT",
  "Creating the PDF took too long. Try a shorter document or try again.");

/** At most `concurrent` tasks at once and `queued` waiting; more are refused straight away. */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly concurrent: number, private readonly queued: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrent) {
      if (this.waiting.length >= this.queued) throw busy();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** Rejects with `onTimeout()` when `work` takes longer than `ms`. */
export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let fontsRegistered = false;

/** Registers the bundled fonts once per process. Hyphenation is off: words are never split across lines. */
function registerFonts() {
  if (fontsRegistered) return;
  const families = new Map<string, { src: string; fontWeight: number; fontStyle: "normal" | "italic" }[]>();
  for (const font of FONT_FILES) {
    const list = families.get(font.family) ?? [];
    list.push({ src: path.join(FONTS_DIR, font.file), fontWeight: font.weight, fontStyle: font.style });
    families.set(font.family, list);
  }
  for (const [family, fonts] of families) Font.register({ family, fonts });
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

export class ReactPdfRenderer implements PdfRenderer {
  private readonly limiter: Limiter;

  constructor(private readonly limits: PdfLimits) {
    registerFonts();
    this.limiter = new Limiter(limits.maxConcurrent, Math.max(1, limits.maxQueued));
  }

  /**
   * Throws 422 when the document is too long or large, 503 when the server is busy or rendering timed out,
   * 500 when rendering failed.
   */
  render(doc: Doc, presetStyles: Record<string, StyleMap>): Promise<RenderedPdf> {
    return this.limiter.run(async () => {
      try {
        return await withTimeout(this.print(doc, presetStyles), this.limits.renderTimeoutMs, timedOut);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "DOCUMENT_TIMEOUT") console.warn(`PDF rendering timed out after ${this.limits.renderTimeoutMs} ms`);
          throw error;
        }
        // First line of the message only (enough to diagnose), cut short
        console.warn(`PDF rendering failed: ${String((error as Error)?.message ?? error).split("\n")[0]!.slice(0, 300)}`);
        throw new ApiError(500, "DOCUMENT_RENDER_FAILED", "We couldn't create the PDF. Please try again.");
      }
    });
  }

  async close() {}

  private async print(doc: Doc, presetStyles: Record<string, StyleMap>): Promise<RenderedPdf> {
    const bytes = await renderToBuffer(toReactPdf(doc, presetStyles) as Parameters<typeof renderToBuffer>[0]);
    if (bytes.length > this.limits.maxBytes) {
      throw new ApiError(422, "DOCUMENT_TOO_LARGE", "This document is too large to create. Shorten some sections and try again.");
    }
    const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    if (pages > this.limits.maxPages) {
      throw new ApiError(422, "DOCUMENT_TOO_LONG", `This document would be ${pages} pages. The limit is `
        + `${this.limits.maxPages}; shorten some sections and try again.`);
    }
    return { bytes, pages };
  }
}

// ---- the cascade ----

/** Engine defaults (doc-rules.md §3), written as CSS so they go through the same conversion as everything else. */
const ENGINE_STYLES: Record<string, StyleMap> = {
  body: { "font-family": "Inter", "font-size": "10pt", "line-height": "1.38", color: "#1f2328" },
  h1: { "font-size": "20pt", "font-weight": "700", "page-break-after": "avoid" },
  h2: { "font-size": "12pt", "font-weight": "700", "page-break-after": "avoid" },
  h3: { "font-size": "10.5pt", "font-weight": "700", "page-break-after": "avoid" },
  h4: { "font-size": "10pt", "font-weight": "700", "page-break-after": "avoid" },
  h5: { "font-size": "10pt", "font-weight": "700", "page-break-after": "avoid" },
  h6: { "font-size": "10pt", "font-weight": "700", "page-break-after": "avoid" },
  a: { "text-decoration": "none" },
  ul: { "padding-left": "13pt" },
  ol: { "padding-left": "13pt" },
  li: { "margin-top": "1.5pt", "margin-bottom": "1.5pt" },
  p: { orphans: "2", widows: "2" },
  strong: { "font-weight": "700" },
  b: { "font-weight": "700" },
  em: { "font-style": "italic" },
  i: { "font-style": "italic" },
  u: { "text-decoration": "underline" },
  s: { "text-decoration": "line-through" },
  small: { "font-size": "0.83em" },
  sub: { "font-size": "0.75em", "vertical-align": "sub" },
  sup: { "font-size": "0.75em", "vertical-align": "super" },
  mark: { "background-color": "#fff3a0" },
  blockquote: { "padding-left": "8pt", "border-left": "1.5pt solid #c1c7d0" },
  hr: { "border-top": "0.75pt solid #c1c7d0", "margin-top": "4pt", "margin-bottom": "4pt" },
  table: { width: "100%" },
  th: { "font-weight": "700" },
};

type Rule = { tag: string | null; cls: string | null; specificity: number; order: number; style: StyleMap };

/** Selectors are body, a tag, a class or tag.class (the reader allows nothing else). */
function compileRules(...sources: Record<string, StyleMap>[]): Rule[] {
  const rules: Rule[] = [];
  let order = 0;
  for (const source of sources) {
    for (const [selector, style] of Object.entries(source)) {
      const [tag, cls] = selector.split(".") as [string, string | undefined];
      rules.push({ tag: tag || null, cls: cls ?? null, specificity: (tag ? 1 : 0) + (cls ? 10 : 0), order: order++, style });
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

/** The node's CSS: matching rules by specificity then source order, then its own style. */
function cascade(rules: Rule[], tag: string, classes: string[], own: StyleMap): StyleMap {
  const css: StyleMap = {};
  for (const rule of rules) {
    if ((rule.tag === null || rule.tag === tag) && (rule.cls === null || classes.includes(rule.cls))) {
      Object.assign(css, rule.style);
    }
  }
  return Object.assign(css, own);
}

// ---- CSS → react-pdf ----

type Style = Record<string, string | number>;

type Converted = {
  style: Style;
  /** react-pdf element props: break, wrap, minPresenceAhead, orphans, widows */
  props: Record<string, unknown>;
  fontSize: number;
  /** Line-height multiplier, inherited unless the element sets one */
  lineHeight: number;
  display: string | null;
  float: "left" | "right" | null;
  nowrap: boolean;
  pre: boolean;
  breakAfter: boolean;
  listStyle: string | null;
};

const PT_PER: Record<string, number> = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72, px: 0.75 };

/** A CSS length in points (or a percentage string, or "auto"), given the element's font size for em. */
export function length(value: string, fontSize: number): number | string | null {
  if (value === "auto") return "auto";
  const m = /^(-?\d+(?:\.\d+)?)(pt|mm|cm|in|px|em|%)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === undefined) return n === 0 ? 0 : null;
  if (unit === "%") return `${n}%`;
  if (unit === "em") return round(n * fontSize);
  return round(n * PT_PER[unit]!);
}

const round = (n: number) => Math.round(n * 100) / 100;

function fontSizeOf(value: string, parent: number): number {
  const m = /^(\d+(?:\.\d+)?)(pt|mm|cm|in|px|em|%)$/.exec(value.trim());
  if (!m) return parent;
  const n = Number(m[1]);
  if (m[2] === "em") return round(n * parent);
  if (m[2] === "%") return round((n / 100) * parent);
  return round(n * PT_PER[m[2]!]!);
}

function colorOf(value: string): string | null {
  if (value.trim().toLowerCase() === "transparent") return null;
  const rgb = parseColor(value);
  return rgb ? `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}` : null;
}

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

/** 1–4 values → top, right, bottom, left (CSS order). */
function boxSides(value: string): [string, string, string, string] {
  const p = value.split(" ");
  const top = p[0]!;
  const right = p[1] ?? top;
  return [top, right, p[2] ?? top, p[3] ?? right];
}

function setBorder(style: Style, side: string, value: string, fontSize: number) {
  if (value === "none" || value === "0") {
    style[`border${side}Width`] = 0;
    return;
  }
  let width: number | string = 0.75;
  let kind = "solid";
  let color = "#000000";
  for (const token of value.split(" ")) {
    const asLength = length(token, fontSize);
    if (typeof asLength === "number") width = asLength;
    else if (["none", "solid", "dashed", "dotted", "double"].includes(token)) kind = token;
    else color = colorOf(token) ?? color;
  }
  if (kind === "none") width = 0;
  style[`border${side}Width`] = width;
  style[`border${side}Style`] = kind === "double" ? "solid" : kind;
  style[`border${side}Color`] = color;
}

const FONT_WEIGHTS: Record<string, number> = { normal: 400, bold: 700, bolder: 700, lighter: 300 };

/**
 * Converts one element's CSS. parentFontSize resolves em and %. parentLineHeight is the inherited multiplier: react-pdf
 * inherits line height already resolved to points, so an element with its own font size states the multiplier again
 * (otherwise a 21pt name would get the 10pt body's line height and overlap the next line).
 */
export function convert(css: StyleMap, parentFontSize: number, parentLineHeight = 1.38): Converted {
  const fontSize = css["font-size"] ? fontSizeOf(css["font-size"], parentFontSize) : parentFontSize;
  const style: Style = {};
  const props: Record<string, unknown> = {};
  if (css["font-size"]) style.fontSize = fontSize;

  for (const [property, value] of Object.entries(css)) {
    switch (property) {
      case "font-family": {
        const first = value.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
        style.fontFamily = resolveFont(first) ?? "Inter";
        break;
      }
      case "font-weight":
        style.fontWeight = FONT_WEIGHTS[value] ?? Number(value);
        break;
      case "font-style":
        style.fontStyle = value === "normal" ? "normal" : "italic";
        break;
      case "color": {
        const color = colorOf(value);
        if (color) style.color = color;
        break;
      }
      case "background-color": {
        const color = colorOf(value);
        if (color) style.backgroundColor = color;
        break;
      }
      case "line-height": {
        if (value === "normal") style.lineHeight = 1.2;
        else if (/^\d+(\.\d+)?$/.test(value)) style.lineHeight = Number(value);
        else {
          const pt = length(value, fontSize);
          if (typeof pt === "number" && pt > 0) style.lineHeight = round(pt / fontSize);
        }
        break;
      }
      case "text-align":
        style.textAlign = value === "start" ? "left" : value === "end" ? "right" : value;
        break;
      case "text-decoration": {
        const parts = value.split(" ").filter((v) => v === "underline" || v === "line-through");
        style.textDecoration = parts.length > 0 ? parts.join(" ") : "none";
        break;
      }
      case "text-transform":
        style.textTransform = value;
        break;
      case "text-indent": {
        const pt = length(value, fontSize);
        if (pt !== null) style.textIndent = pt;
        break;
      }
      case "vertical-align":
        if (value === "sub" || value === "super") style.verticalAlign = value;
        break;
      case "margin":
      case "padding":
        boxSides(value).forEach((v, i) => {
          const pt = length(v, fontSize);
          if (pt !== null) style[`${property}${SIDES[i]}`] = pt;
        });
        break;
      case "margin-top": case "margin-right": case "margin-bottom": case "margin-left":
      case "padding-top": case "padding-right": case "padding-bottom": case "padding-left": {
        const [box, side] = property.split("-") as [string, string];
        const pt = length(value, fontSize);
        if (pt !== null) style[`${box}${side[0]!.toUpperCase()}${side.slice(1)}`] = pt;
        break;
      }
      case "width": case "min-width": case "max-width": case "height": case "min-height": case "max-height": {
        if (value === "none") break;
        const key = property.replace(/-(\w)/, (_, c: string) => c.toUpperCase());
        const pt = length(value, fontSize);
        if (pt !== null) style[key] = pt;
        break;
      }
      case "border":
        for (const side of SIDES) setBorder(style, side, value, fontSize);
        break;
      case "border-top": case "border-right": case "border-bottom": case "border-left": {
        const side = property.slice(7);
        setBorder(style, `${side[0]!.toUpperCase()}${side.slice(1)}`, value, fontSize);
        break;
      }
      case "border-width": case "border-style": case "border-color": {
        const part = property.slice(7);
        boxSides(value).forEach((v, i) => {
          const key = `border${SIDES[i]}${part[0]!.toUpperCase()}${part.slice(1)}`;
          if (part === "width") style[key] = length(v, fontSize) ?? 0;
          else if (part === "color") style[key] = colorOf(v) ?? "#000000";
          else style[key] = v === "double" ? "solid" : v;
        });
        break;
      }
      case "border-radius": {
        const pt = length(value.split(" ")[0]!, fontSize);
        if (pt !== null) style.borderRadius = pt;
        break;
      }
      case "page-break-before":
        if (value === "always" || value === "left" || value === "right") props.break = true;
        break;
      case "page-break-inside":
        if (value === "avoid") props.wrap = false;
        break;
      case "page-break-after":
        if (value === "avoid") props.minPresenceAhead = props.minPresenceAhead ?? 36;
        break;
      case "-fs-page-break-min-height": {
        const pt = length(value, fontSize);
        if (typeof pt === "number") props.minPresenceAhead = pt;
        break;
      }
      case "orphans":
      case "widows":
        props[property] = Number(value);
        break;
      default:
        // white-space, word-break, word-wrap, clear, border-collapse, border-spacing, list-style-position:
        // react-pdf wraps text itself; these need no conversion
        break;
    }
  }
  const lineHeight = typeof style.lineHeight === "number" ? style.lineHeight : parentLineHeight;
  if (css["font-size"] && style.lineHeight === undefined) style.lineHeight = lineHeight;
  const pageBreakAfter = css["page-break-after"];
  return {
    style,
    props,
    fontSize,
    lineHeight,
    display: css.display ?? null,
    float: css.float === "left" || css.float === "right" ? css.float : null,
    nowrap: css["white-space"] === "nowrap",
    pre: css["white-space"] === "pre" || css["white-space"] === "pre-wrap",
    breakAfter: pageBreakAfter === "always" || pageBreakAfter === "left" || pageBreakAfter === "right",
    listStyle: css["list-style-type"] ?? null,
  };
}

// ---- document → elements ----

type Ctx = {
  rules: Rule[];
  fontSize: number;
  lineHeight: number;
  pre: boolean;
  /** list-style-type inherited from the enclosing list */
  listStyle: string | null;
};

const h = (type: unknown, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement =>
  createElement(type as never, props as never, ...children);

let keys = 0;
const key = () => `k${keys++}`;

function nodeCss(node: DocNode, ctx: Ctx): Converted {
  return convert(cascade(ctx.rules, node.tag, node.classes, node.style), ctx.fontSize, ctx.lineHeight);
}

const isInline = (node: DocNode, c: Converted | null) =>
  node.tag === "#text" || (INLINE.has(node.tag) && (c === null || (c.display !== "block" && c.display !== "table")));

/** Text of a #text node or an element's text field. html whitespace collapses; text keeps its line breaks. */
function textOf(value: string, fromHtml: boolean, pre: boolean): string {
  const cleaned = clean(value);
  if (pre) return cleaned;
  return fromHtml ? cleaned.replace(/[ \t\r\n\f]+/g, " ") : cleaned.replace(/\r\n/g, "\n").replace(/[ \t\f]+/g, " ");
}

/** An inline node inside a <Text>. */
function inline(node: DocNode, ctx: Ctx): ReactNode {
  if (node.tag === "#text") return textOf(node.text ?? "", true, ctx.pre);
  if (!node.visible) return null;
  if (node.tag === "br") return "\n";
  const c = nodeCss(node, ctx);
  if (c.display === "none") return null;
  const inner: Ctx = { ...ctx, fontSize: c.fontSize, lineHeight: c.lineHeight, pre: ctx.pre || c.pre };
  const children: ReactNode[] = node.text != null
    ? [textOf(node.text, false, inner.pre)]
    : node.children.map((child) => inline(child, inner));
  if (node.tag === "a" && node.attrs.href) {
    return h(Link, { key: key(), src: node.attrs.href, style: c.style }, ...children);
  }
  return h(Text, { key: key(), style: c.style }, ...children);
}

/** True when a run of inline nodes would print nothing but whitespace. */
function blankRun(nodes: DocNode[]): boolean {
  return nodes.every((n) => n.tag === "#text" && !(n.text ?? "").trim());
}

/**
 * Children of a block: consecutive inline nodes share one <Text>; blocks become their own elements. Floated children
 * go to the start (left) or end (right) of a row next to the rest.
 */
function flow(nodes: DocNode[], ctx: Ctx): ReactNode[] {
  const visible = nodes.filter((n) => n.tag === "#text" || n.visible);
  const floats = visible.map((n) => (n.tag === "#text" ? null : nodeCss(n, ctx).float));
  if (floats.some((f) => f !== null)) {
    const left = visible.filter((_, i) => floats[i] === "left");
    const right = visible.filter((_, i) => floats[i] === "right");
    const rest = visible.filter((_, i) => floats[i] === null);
    const piece = (n: DocNode) => (isInline(n, null) ? h(Text, { key: key() }, inline(n, ctx)) : block(n, ctx));
    return [h(View, { key: key(), style: { flexDirection: "row", alignItems: "flex-start" } },
      ...left.map(piece),
      h(View, { key: key(), style: { flexGrow: 1, flexShrink: 1 } }, ...flow(rest, ctx)),
      ...right.map(piece))];
  }

  const out: ReactNode[] = [];
  let run: DocNode[] = [];
  const flush = () => {
    if (run.length > 0 && !blankRun(run)) out.push(h(Text, { key: key() }, ...run.map((n) => inline(n, ctx))));
    run = [];
  };
  for (const node of visible) {
    if (isInline(node, node.tag === "#text" ? null : nodeCss(node, ctx))) {
      run.push(node);
      continue;
    }
    flush();
    const c = nodeCss(node, ctx);
    if (c.display === "none") continue;
    out.push(block(node, ctx));
    if (c.breakAfter) out.push(h(View, { key: key(), break: true }));
  }
  flush();
  return out;
}

const ROMAN: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

function roman(n: number) {
  let out = "";
  for (const [value, letters] of ROMAN) {
    while (n >= value) {
      out += letters;
      n -= value;
    }
  }
  return out;
}

const alpha = (n: number) => {
  let out = "";
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(97 + ((v - 1) % 26)) + out;
  return out;
};

/** The marker of item n (1-based) for a list style; null for none. */
export function listMarker(style: string, n: number): string | null {
  switch (style) {
    case "none": return null;
    case "decimal": return `${n}.`;
    case "lower-alpha": return `${alpha(n)}.`;
    case "upper-alpha": return `${alpha(n).toUpperCase()}.`;
    case "lower-roman": return `${roman(n)}.`;
    case "upper-roman": return `${roman(n).toUpperCase()}.`;
    default: return "•";
  }
}

const OL_TYPES: Record<string, string> = { "1": "decimal", a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman" };

const MARKER_WIDTH = 13;

/** A block-level element. */
function block(node: DocNode, ctx: Ctx): ReactNode {
  const c = nodeCss(node, ctx);
  if (!node.visible || c.display === "none") return null;
  const inner: Ctx = { ...ctx, fontSize: c.fontSize, lineHeight: c.lineHeight, pre: ctx.pre || c.pre || node.tag === "pre" };
  const own = { key: key(), ...c.props };

  if (node.tag === "hr") return h(View, { ...own, style: c.style });

  // Lists: each item is a row with its marker hanging in the list's left padding
  if (node.tag === "ul" || node.tag === "ol") {
    const listStyle = c.listStyle ?? (node.tag === "ol" ? OL_TYPES[node.attrs.type ?? "1"] ?? "decimal" : "disc");
    const start = node.tag === "ol" && node.attrs.start ? Number(node.attrs.start) : 1;
    let n = start;
    return h(View, { ...own, style: c.style },
      ...node.children.filter((li) => li.visible).map((li) => listItem(li, { ...inner, listStyle }, n++)));
  }

  // Rows: tables, table rows and display: table
  const row = node.tag === "tr" || c.display === "table" || c.display === "table-row";
  if (node.tag === "table" || node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") {
    return h(View, { ...own, style: c.style }, ...node.children.filter((r) => r.visible).map((r) => block(r, inner)));
  }
  if (row) {
    return h(View, { ...own, style: { flexDirection: "row", alignItems: "flex-start", ...c.style } },
      ...node.children.filter((cell) => cell.visible).map((cell) => tableCell(cell, inner)));
  }

  // Text blocks hold inline content only: one <Text>, unless a floated child needs a row
  if (TEXT_BLOCKS.has(node.tag) || (!CONTAINERS.has(node.tag) && INLINE.has(node.tag))) {
    if (node.text != null) return h(Text, { ...own, style: c.style }, textOf(node.text, false, inner.pre));
    const floats = node.children.some((child) => child.tag !== "#text" && nodeCss(child, inner).float !== null);
    if (!floats) return h(Text, { ...own, style: c.style }, ...node.children.map((child) => inline(child, inner)));
    return h(View, { ...own, style: c.style }, ...flow(node.children, inner));
  }

  // Containers: blocks and inline runs
  if (node.text != null) {
    return h(View, { ...own, style: c.style }, h(Text, { key: key() }, textOf(node.text, false, inner.pre)));
  }
  return h(View, { ...own, style: c.style }, ...flow(node.children, inner));
}

/** A table cell: shares the row's width; a set width is kept; a "nowrap" cell takes only what it needs. */
function tableCell(cell: DocNode, ctx: Ctx): ReactNode {
  const c = nodeCss(cell, ctx);
  if (c.display === "none") return null;
  const span = Number(cell.attrs.colspan ?? 1);
  const sizing: Style = c.nowrap
    ? { flexGrow: 0, flexShrink: 0 }
    : c.style.width !== undefined
      ? { flexGrow: 0, flexShrink: 1 }
      : { flexGrow: span, flexShrink: 1, flexBasis: 0 };
  const style = { ...sizing, ...c.style };
  if (c.nowrap) delete style.width;
  const inner: Ctx = { ...ctx, fontSize: c.fontSize, lineHeight: c.lineHeight, pre: ctx.pre || c.pre };
  const content = cell.text != null
    ? [h(Text, { key: key() }, textOf(cell.text, false, inner.pre))]
    : TEXT_BLOCKS.has(cell.tag)
      ? [h(Text, { key: key() }, ...cell.children.map((child) => inline(child, inner)))]
      : flow(cell.children, inner);
  return h(View, { key: key(), ...c.props, style }, ...content);
}

function listItem(li: DocNode, ctx: Ctx, n: number): ReactNode {
  const c = nodeCss(li, ctx);
  if (c.display === "none") return null;
  const marker = listMarker(c.listStyle ?? ctx.listStyle ?? "disc", n);
  const inner: Ctx = { ...ctx, fontSize: c.fontSize, lineHeight: c.lineHeight, pre: ctx.pre || c.pre };
  const content = li.text != null
    ? [h(Text, { key: key() }, textOf(li.text, false, inner.pre))]
    : flow(li.children, inner);
  return h(View, { key: key(), ...c.props, style: { flexDirection: "row", ...c.style } },
    h(Text, { key: key(), style: { width: MARKER_WIDTH, marginLeft: -MARKER_WIDTH } }, marker ?? ""),
    h(View, { key: key(), style: { flexGrow: 1, flexShrink: 1 } }, ...content));
}

/** The whole document as react-pdf elements. */
export function toReactPdf(doc: Doc, presetStyles: Record<string, StyleMap>): ReactElement {
  keys = 0;
  const rules = compileRules(ENGINE_STYLES, presetStyles, doc.styles);
  const body = convert(cascade(rules, "body", [], {}), 10, 1.2);
  const ctx: Ctx = { rules, fontSize: body.fontSize, lineHeight: body.lineHeight, pre: false, listStyle: null };
  const [top, right, bottom, left] = boxSides(doc.page.margin).map((v) => length(v, 10) as number) as [number, number, number, number];

  const sections = doc.sections.filter((s) => s.visible).map((section) => {
    const c = convert(cascade(rules, "section", ["section"], section.style), ctx.fontSize, ctx.lineHeight);
    return h(View, { key: key(), ...c.props, style: c.style },
      ...flow(section.nodes, { ...ctx, fontSize: c.fontSize, lineHeight: c.lineHeight }));
  });

  const pageNumbers = doc.page.pageNumbers
    ? h(Text, {
      key: "page-number",
      fixed: true,
      style: { position: "absolute", bottom: Math.max(8, bottom / 2 - 4), right, fontFamily: "Inter", fontSize: 7.5,
        color: "#6b6e76", fontWeight: 400, fontStyle: "normal" },
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
    })
    : null;

  const label = doc.document === "coverLetter" ? "Cover letter" : "Resume";
  return h(Document, {
    title: doc.meta.title ?? label,
    author: doc.meta.author ?? undefined,
    subject: doc.meta.subject ?? label,
    language: doc.meta.language,
    creator: "CareerPilot",
    producer: "CareerPilot",
  }, h(Page, {
    size: doc.page.size === "LETTER" ? "LETTER" : "A4",
    style: { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left, ...body.style },
  }, ...sections, pageNumbers));
}
