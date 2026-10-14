import type { Doc, DocNode, StyleMap } from "./model.js";

/* Writes a Doc back as document JSON (e.g. the repaired document from lenient validation). */

export type JsonObject = Record<string, unknown>;

export function writeDocJson(doc: Doc): JsonObject {
  const root: JsonObject = { schemaVersion: 3, document: doc.document };
  if (doc.preset != null) root.preset = doc.preset;
  const meta: JsonObject = {};
  putIfSet(meta, "title", doc.meta.title);
  putIfSet(meta, "author", doc.meta.author);
  putIfSet(meta, "subject", doc.meta.subject);
  meta.language = doc.meta.language;
  root.meta = meta;
  root.page = {
    size: doc.page.size,
    margin: doc.page.margin,
    maxPages: doc.page.maxPages,
    pageNumbers: doc.page.pageNumbers,
  };
  if (Object.keys(doc.styles).length > 0) {
    root.styles = Object.fromEntries(Object.entries(doc.styles).map(([selector, style]) => [selector, { ...style }]));
  }
  root.sections = doc.sections.map((section) => {
    const s: JsonObject = { id: section.id };
    putIfSet(s, "title", section.title);
    if (!section.visible) s.visible = false;
    if (Object.keys(section.style).length > 0) s.style = { ...section.style };
    s.nodes = section.nodes.map(writeNode);
    return s;
  });
  return root;
}

function writeNode(node: DocNode): JsonObject {
  const n: JsonObject = {};
  putIfSet(n, "id", node.id);
  n.tag = node.tag;
  if (node.classes.length > 0) n.class = node.classes.join(" ");
  if (notEmpty(node.style)) n.style = { ...node.style };
  if (notEmpty(node.attrs)) n.attrs = { ...node.attrs };
  if (!node.visible) n.visible = false;
  putIfSet(n, "role", node.role);
  if (node.data != null) n.data = node.data;
  if (node.text != null) n.text = node.text;
  else if (node.html != null) n.html = node.html;
  else if (node.children.length > 0) n.children = node.children.map(writeNode);
  return n;
}

const notEmpty = (values: StyleMap) => Object.keys(values).length > 0;

function putIfSet(target: JsonObject, name: string, value: string | null) {
  if (value != null) target[name] = value;
}
