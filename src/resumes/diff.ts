import { isTag, isText, type ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";

import { layoutBottom, layoutLeft, layoutRight, layoutTop, normalize, type ResumeData, type Section } from "./resume-data.js";
import { dates } from "./resume-to-doc.js";
import { richTextToPlain } from "./rich-text.js";

/*
 * What changed between two resumes, in words a person can review ("Experience › CRED: bullets changed").
 * Sections and items are matched by id, which is why the JSON format keeps ids: an assistant that edits a resume
 * should keep existing ids and give new items new ones. Formatting markers are ignored in the text.
 */

/** kind: ADDED, REMOVED, CHANGED, MOVED, SHOWN or HIDDEN; where: e.g. "Experience › Software Engineer". */
export type Change = { kind: string; where: string; field: string | null; before: string | null; after: string | null };

const change = (kind: string, where: string, field: string | null, before: string | null, after: string | null): Change =>
  ({ kind, where, field, before, after });

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// ---- form data (schema version 2) ----

const mmText = (value: number) => (Number.isInteger(value) ? String(value) : String(value));

/** "15 / 16 / 16 / 16 mm" (top / right / bottom / left), or null for the template default. */
function margins(data: ResumeData) {
  const l = data.layout;
  return l ? `${mmText(layoutTop(l))} / ${mmText(layoutRight(l))} / ${mmText(layoutBottom(l))} / ${mmText(layoutLeft(l))} mm` : null;
}

export function resumeDiff(beforeRaw: unknown, afterRaw: unknown): Change[] {
  const before = normalize(beforeRaw);
  const after = normalize(afterRaw);
  const changes: Change[] = [];

  field(changes, "Basics", "name", before.basics.fullName, after.basics.fullName);
  field(changes, "Basics", "headline", before.basics.headline, after.basics.headline);
  field(changes, "Basics", "email", before.basics.email, after.basics.email);
  field(changes, "Basics", "phone", before.basics.phone, after.basics.phone);
  field(changes, "Basics", "location", before.basics.location, after.basics.location);
  field(changes, "Basics", "links", links(before), links(after));
  field(changes, "Page", "margins", margins(before), margins(after));

  const old = new Map(before.sections.map((s) => [s.id, s]));
  const current = new Map(after.sections.map((s) => [s.id, s]));

  for (const s of after.sections) {
    const previous = old.get(s.id);
    if (!previous) {
      changes.push(change("ADDED", s.title, null, null, summary(s)));
      continue;
    }
    const where = s.title;
    field(changes, where, "title", previous.title, s.title);
    if (previous.visible !== s.visible) changes.push(change(s.visible ? "SHOWN" : "HIDDEN", where, null, null, null));
    if (previous.type !== s.type) {
      changes.push(change("CHANGED", where, "type", previous.type, s.type));
      continue;
    }
    switch (s.type) {
      case "text":
        field(changes, where, "text", richTextToPlain(previous.content), richTextToPlain(s.content));
        break;
      case "entries":
        items(changes, where, previous.entries, s.entries, (e) => e.id, (e) => e.title, (e) => ({
          title: e.title,
          subtitle: e.subtitle ?? "",
          location: e.location ?? "",
          dates: dates(e.startDate, e.endDate, e.current) ?? "",
          link: e.url ?? "",
          description: richTextToPlain(e.description) ?? "",
          bullets: e.bullets.map((b) => richTextToPlain(b) ?? "").join("\n"),
          visible: hidden(e.visible),
        }));
        break;
      case "list":
        items(changes, where, previous.items, s.items, (i) => i.id, (i) => richTextToPlain(i.text) ?? "",
          (i) => ({ text: richTextToPlain(i.text) ?? "", visible: hidden(i.visible) }));
        break;
      case "skills":
        items(changes, where, previous.groups, s.groups, (g) => g.id, (g) => g.name ?? g.keywords.join(", "),
          (g) => ({ name: g.name ?? "", skills: g.keywords.join(", "), visible: hidden(g.visible) }));
        break;
    }
  }
  for (const s of before.sections) {
    if (!current.has(s.id)) changes.push(change("REMOVED", s.title, null, summary(s), null));
  }
  const oldOrder = [...old.keys()].filter((id) => current.has(id));
  const newOrder = [...current.keys()].filter((id) => old.has(id));
  if (!sameOrder(oldOrder, newOrder)) {
    changes.push(change("MOVED", "Section order", null, titles(oldOrder, old), titles(newOrder, current)));
  }
  return changes;
}

function items<T>(changes: Change[], section: string, before: T[], after: T[], id: (item: T) => string,
  label: (item: T) => string, fields: (item: T) => Record<string, string>) {
  const old = new Map(before.map((item) => [id(item), item]));
  const current = new Map(after.map((item) => [id(item), item]));
  for (const item of after) {
    const previous = old.get(id(item));
    const where = `${section} › ${label(item)}`;
    if (previous === undefined) {
      changes.push(change("ADDED", where, null, null, nonBlank(fields(item)).join(" · ")));
      continue;
    }
    const was = fields(previous);
    for (const [name, value] of Object.entries(fields(item))) field(changes, where, name, was[name] ?? null, value);
  }
  for (const item of before) {
    if (!current.has(id(item))) {
      changes.push(change("REMOVED", `${section} › ${label(item)}`, null, nonBlank(fields(item)).join(" · "), null));
    }
  }
  const oldOrder = [...old.keys()].filter((key) => current.has(key));
  const newOrder = [...current.keys()].filter((key) => old.has(key));
  if (!sameOrder(oldOrder, newOrder)) changes.push(change("MOVED", section, null, null, null));
}

const hidden = (visible: boolean) => (visible ? "shown" : "hidden");

function field(changes: Change[], where: string, name: string, before: string | null, after: string | null) {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== b) changes.push(change("CHANGED", where, name, a || null, b || null));
}

const nonBlank = (fields: Record<string, string>) =>
  Object.entries(fields).filter(([key]) => key !== "visible").map(([, value]) => value).filter((value) => value.trim() !== "");

const links = (data: ResumeData) => data.basics.links.map((link) => link.url).join(", ");

const titles = (ids: string[], sections: Map<string, Section>) => ids.map((id) => sections.get(id)!.title).join(" → ");

function summary(s: Section): string | null {
  switch (s.type) {
    case "text":
      return richTextToPlain(s.content);
    case "entries":
      return `${s.entries.length} item(s)`;
    case "list":
      return `${s.items.length} item(s)`;
    case "skills":
      return `${s.groups.length} group(s)`;
  }
}

// ---- docEngine documents (schema version 3), same Change shape so one review screen works for both ----

const MAX_DIFF_TEXT = 400;

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (value: Json): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null);
const visibleOf = (node: Json) => !(isObject(node) && node.visible === false);
/**
 * Compact JSON with sorted keys, or "" when absent. Sorted because PostgreSQL jsonb reorders keys, so a stored
 * document and a freshly converted one would otherwise differ only in key order.
 */
const compact = (value: Json): string => {
  if (value === undefined || value === null) return "";
  const sortKeys = (v: Json): Json => Array.isArray(v) ? v.map(sortKeys)
    : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, sortKeys(v[key])])) : v;
  return JSON.stringify(sortKeys(value));
};
const cut = (value: string) => (value.length > MAX_DIFF_TEXT ? `${value.slice(0, MAX_DIFF_TEXT - 1)}…` : value);

export function docDiff(before: JsonObject, after: JsonObject): Change[] {
  const changes: Change[] = [];
  docField(changes, "Document", "preset", str(before.preset), str(after.preset));
  docField(changes, "Document", "page", compact(before.page), compact(after.page));
  docField(changes, "Document", "styles", compact(before.styles), compact(after.styles));

  const old = sectionsById(before.sections);
  const current = sectionsById(after.sections);
  for (const [key, section] of current) {
    const previous = old.get(key);
    const where = sectionLabel(section);
    if (!previous) {
      changes.push(change("ADDED", where, null, null, cut(plain(isObject(section) ? section.nodes : null))));
      continue;
    }
    const visible = visibleOf(section);
    if (visibleOf(previous) !== visible) changes.push(change(visible ? "SHOWN" : "HIDDEN", where, null, null, null));
    docField(changes, where, "style", compact(isObject(previous) ? previous.style : null), compact(isObject(section) ? section.style : null));
    nodes(changes, where, isObject(previous) ? previous.nodes : null, isObject(section) ? section.nodes : null);
  }
  for (const [key, section] of old) {
    if (!current.has(key)) {
      changes.push(change("REMOVED", sectionLabel(section), null, cut(plain(isObject(section) ? section.nodes : null)), null));
    }
  }
  const oldOrder = [...old.keys()].filter((key) => current.has(key));
  const newOrder = [...current.keys()].filter((key) => old.has(key));
  if (!sameOrder(oldOrder, newOrder)) {
    changes.push(change("MOVED", "Section order", null, oldOrder.join(", "), newOrder.join(", ")));
  }
  return changes;
}

function nodes(changes: Change[], section: string, before: Json, after: Json) {
  const old = nodesByKey(before);
  const current = nodesByKey(after);
  for (const [key, node] of current) {
    const previous = old.get(key);
    const where = `${section} › ${nodeLabel(node, key)}`;
    if (previous === undefined) {
      changes.push(change("ADDED", where, null, null, cut(plain(node))));
      continue;
    }
    docField(changes, where, "text", plain(previous), plain(node));
    const p = isObject(previous) ? previous : {};
    const n = isObject(node) ? node : {};
    docField(changes, where, "style", compact(p.style) + compact(p.class), compact(n.style) + compact(n.class));
    if (visibleOf(previous) !== visibleOf(node)) {
      changes.push(change(visibleOf(node) ? "SHOWN" : "HIDDEN", where, null, null, null));
    }
  }
  for (const [key, node] of old) {
    if (!current.has(key)) changes.push(change("REMOVED", `${section} › ${nodeLabel(node, key)}`, null, cut(plain(node)), null));
  }
}

function sectionsById(sections: Json) {
  const map = new Map<string, Json>();
  arrayOf(sections).forEach((section, i) => {
    map.set((isObject(section) ? str(section.id) : null) ?? `#${i}`, section);
  });
  return map;
}

/** Nodes with an id are matched by id; others by their position among the id-less nodes. */
function nodesByKey(list: Json) {
  const map = new Map<string, Json>();
  let position = 0;
  for (const node of arrayOf(list)) {
    const id = isObject(node) ? str(node.id) : null;
    map.set(id != null ? `id:${id}` : `#${position++}`, node);
  }
  return map;
}

function sectionLabel(section: Json) {
  const s = isObject(section) ? section : {};
  return str(s.title) ?? str(s.id) ?? "Section";
}

function nodeLabel(node: Json, key: string) {
  const text = plain(node);
  if (!text) return key.startsWith("id:") ? key.slice(3) : `<${(isObject(node) ? str(node.tag) : null) ?? "node"}>`;
  return text.length > 50 ? `${text.slice(0, 47)}…` : text;
}

/** The node's visible text (text, html without tags, or children), spaces collapsed. */
export function plain(node: Json): string {
  let out = "";
  const collect = (value: Json) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const child of value) {
        collect(child);
        out += " ";
      }
      return;
    }
    if (!isObject(value)) return;
    if ("text" in value) out += str(value.text) ?? "";
    else if ("html" in value) out += htmlText(str(value.html) ?? "");
    else if ("children" in value) collect(value.children);
    else if ("nodes" in value) collect(value.nodes);
  };
  collect(node);
  return out.replace(/\s+/g, " ").trim();
}

/** Text content of an html fragment, like jsoup's text(): tags dropped, whitespace normalized. */
function htmlText(html: string): string {
  const parts: string[] = [];
  const walk = (list: ChildNode[]) => {
    for (const child of list) {
      if (isText(child)) parts.push(child.data);
      else if (isTag(child)) {
        if (child.name === "br") parts.push(" ");
        walk(child.children);
      }
    }
  };
  walk(parseDocument(html).children);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function docField(changes: Change[], where: string, name: string, before: string | null, after: string | null) {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== b) changes.push(change("CHANGED", where, name, a ? cut(a) : null, b ? cut(b) : null));
}
