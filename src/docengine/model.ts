/*
 * A validated document (docEngine JSON, schema version 3). Only the reader (reader.ts) creates these, so every
 * value has already passed the rules in docengine/spec/doc-rules.md: allowed tags, attributes, CSS properties and
 * values, links, fonts and limits. The writer can print them without further checks.
 */

export type DocKind = "resume" | "coverLetter";

/** Paper size of a generated document. A4 is the default outside North America. */
export type PageSize = "A4" | "LETTER";

/** Value for the CSS `@page { size: … }` rule. */
export const pageSizeCss = (size: PageSize) => (size === "A4" ? "A4" : "letter");

export type StyleMap = Record<string, string>;

/** `styles` keeps insertion order: later rules win, like CSS. */
export type Doc = {
  schemaVersion: number;
  document: DocKind;
  preset: string | null;
  meta: Meta;
  page: Page;
  styles: Record<string, StyleMap>;
  sections: Section[];
};

/** PDF metadata and language. */
export type Meta = { title: string | null; author: string | null; subject: string | null; language: string };

/** margin: normalized CSS shorthand in mm, e.g. "15mm 16mm 16mm 16mm" */
export type Page = { size: PageSize; margin: string; maxPages: number; pageNumbers: boolean };

/** Printed as <section id="…" class="section">. Hidden sections are kept but not printed. */
export type Section = { id: string; title: string | null; visible: boolean; style: StyleMap; nodes: DocNode[] };

/**
 * One element. `tag` is "#text" for a plain text run (only inside `children` built from an `html` string).
 * Content is `text`, or `children` (given directly or parsed from `html`, which is also kept, sanitized, so the
 * document can be written back the same way).
 */
export type DocNode = {
  id: string | null;
  tag: string;
  classes: string[];
  style: StyleMap;
  attrs: StyleMap;
  visible: boolean;
  text: string | null;
  html: string | null;
  children: DocNode[];
  role: string | null;
  data: unknown;
};

export const TEXT_TAG = "#text";

export const textNode = (value: string): DocNode => ({
  id: null, tag: TEXT_TAG, classes: [], style: {}, attrs: {}, visible: true, text: value, html: null, children: [],
  role: null, data: null,
});

export const isTextNode = (node: DocNode) => node.tag === TEXT_TAG;
