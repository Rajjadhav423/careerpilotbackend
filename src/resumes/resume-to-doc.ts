import { webLink } from "../docengine/safe-urls.js";
import type { PageSize } from "../docengine/model.js";
import { layoutBottom, layoutLeft, layoutRight, layoutTop, normalize, type ResumeData, type Section } from "./resume-data.js";
import { richTextParagraphs, richTextToXhtml } from "./rich-text.js";

/*
 * Converts a resume in the editor's format (schema version 2: basics + typed sections) into docEngine JSON (schema
 * version 3) using a preset's classes, so resumes render through the document engine. Text fields go through
 * rich-text.ts, which only produces escaped text with strong/em/a.
 */

type JsonObject = Record<string, unknown>;

/** Text with an optional safe link (http(s) or mailto). */
export type Contact = { text: string; href: string | null };

/** Link text without the scheme ("github.com/raj"), which reads better and survives ATS link stripping. */
export function contactLink(url: string | null): Contact | null {
  const safe = webLink(url);
  if (!safe) return null;
  let text = safe.replace(/^https?:\/\/(www\.)?/, "");
  if (text.endsWith("/")) text = text.slice(0, -1);
  return { text, href: safe };
}

export function dates(start: string | null, end: string | null, current: boolean): string | null {
  const finish = current ? "Present" : end;
  const blank = (value: string | null) => value == null || value.trim() === "";
  if (blank(start)) return blank(finish) ? null : finish;
  return blank(finish) ? start : `${start} – ${finish}`;
}

export function join(separator: string, ...parts: (string | null)[]): string | null {
  const joined = parts.filter((part): part is string => part != null && part.trim() !== "").join(separator);
  return joined === "" ? null : joined;
}

function contacts(data: ResumeData): Contact[] {
  const basics = data.basics;
  const list: Contact[] = [];
  if (basics.email != null) list.push({ text: basics.email, href: `mailto:${basics.email}` });
  if (basics.phone != null) list.push({ text: basics.phone, href: null });
  if (basics.location != null) list.push({ text: basics.location, href: null });
  for (const link of basics.links) {
    const contact = contactLink(link.url);
    if (contact) list.push(contact);
  }
  return list;
}

const MONTH_YEAR = /^([a-z]{3,9})\.?\s+(\d{4})$/i;
const NUMERIC = /^(?:(\d{4})(?:[-/.](\d{1,2}))?|(\d{1,2})[-/.](\d{4}))$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Jan 2022" → "2022-01", "2022" → "2022", "01/2022" → "2022-01"; null when it can't be read. */
export function isoDate(value: string | null): string | null {
  if (value == null) return null;
  const v = value.trim();
  const named = MONTH_YEAR.exec(v);
  if (named) {
    const month = MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase());
    return month < 0 ? named[2]! : `${named[2]}-${String(month + 1).padStart(2, "0")}`;
  }
  const numeric = NUMERIC.exec(v);
  if (numeric) {
    const year = numeric[1] ?? numeric[4]!;
    const month = numeric[1] !== undefined ? numeric[2] : numeric[3];
    if (month === undefined) return year;
    const m = Number(month);
    return m >= 1 && m <= 12 ? `${year}-${String(m).padStart(2, "0")}` : year;
  }
  return null;
}

function mm(value: number) {
  const clamped = Math.max(0, Math.min(40, value));
  return Number.isInteger(clamped) ? String(clamped) : String(Math.round(clamped * 10) / 10);
}

function node(parent: JsonObject[], tag: string, classes: string | null, role: string | null): JsonObject {
  const n: JsonObject = { tag };
  if (classes != null) n.class = classes;
  if (role != null) n.role = role;
  parent.push(n);
  return n;
}

export function resumeToDoc(presetId: string, pageSize: PageSize | null, raw: unknown): JsonObject {
  const data = normalize(raw);
  const name = data.basics.fullName;
  const ids = new Set<string>();
  for (const s of data.sections) {
    ids.add(s.id);
    for (const e of s.entries) ids.add(e.id);
    for (const i of s.items) ids.add(i.id);
    for (const g of s.groups) ids.add(g.id);
  }

  const page: JsonObject = { size: pageSize ?? "A4" };
  if (data.layout) {
    const l = data.layout;
    page.margin = `${mm(layoutTop(l))}mm ${mm(layoutRight(l))}mm ${mm(layoutBottom(l))}mm ${mm(layoutLeft(l))}mm`;
  }
  const sections: JsonObject[] = [];
  sections.push(header(data, unique("header", ids)));
  for (const section of data.sections) {
    if (section.visible) {
      const converted = convertSection(section);
      if (converted) sections.push(converted);
    }
  }
  return {
    schemaVersion: 3,
    document: "resume",
    preset: presetId,
    meta: { title: `${name} — Resume`, author: name, subject: "Resume", language: "en" },
    page,
    sections,
  };

  function unique(base: string, used: Set<string>) {
    let candidate = base;
    let n = 1;
    while (used.has(candidate)) candidate = `${base}-${n++}`;
    used.add(candidate);
    return candidate;
  }
}

function header(data: ResumeData, id: string): JsonObject {
  const nodes: JsonObject[] = [];
  node(nodes, "h1", "name header", "name").text = data.basics.fullName;
  if (data.basics.headline != null) node(nodes, "p", "headline header", "headline").text = data.basics.headline;
  const list = contacts(data);
  if (list.length > 0) {
    const parts: JsonObject[] = [];
    node(nodes, "p", "contact header", "contact").children = parts;
    list.forEach((contact, i) => {
      if (i > 0) node(parts, "span", "sep", null).text = " | ";
      if (contact.href != null) {
        const link = node(parts, "a", "contact-link", "link");
        link.attrs = { href: contact.href };
        link.text = contact.text;
      } else {
        parts.push({ tag: "span", text: contact.text });
      }
    });
  }
  return { id, title: "Header", style: { "margin-top": "0" }, nodes };
}

/** A visible section with something to show; empty ones are skipped. */
function convertSection(s: Section): JsonObject | null {
  const nodes: JsonObject[] = [];
  node(nodes, "h2", "section-title", "section-title").text = s.title;
  const content = s.type === "text" ? text(s, nodes)
    : s.type === "entries" ? entries(s, nodes)
      : s.type === "list" ? list(s, nodes)
        : skills(s, nodes);
  return content ? { id: s.id, title: s.title, nodes } : null;
}

function text(s: Section, nodes: JsonObject[]) {
  const paragraphs = richTextParagraphs(s.content);
  paragraphs.forEach((paragraph, i) => {
    node(nodes, "p", i === 0 ? "summary first" : "summary", "summary").html = paragraph;
  });
  return paragraphs.length > 0;
}

function entries(s: Section, nodes: JsonObject[]) {
  let first = true;
  for (const e of s.entries) {
    if (!e.visible) continue;
    const entry = node(nodes, "div", first ? "entry first" : "entry", "entry");
    first = false;
    entry.id = e.id;
    const data: JsonObject = { title: e.title };
    if (e.subtitle != null) data.org = e.subtitle;
    const start = isoDate(e.startDate);
    if (start) data.start = start;
    if (e.current) data.end = null;
    else {
      const end = isoDate(e.endDate);
      if (end) data.end = end;
    }
    entry.data = data;
    const children: JsonObject[] = [];
    entry.children = children;

    const head: JsonObject[] = [];
    node(children, "div", "entry-head", null).children = head;
    const main: JsonObject[] = [];
    node(head, "div", "entry-main", null).children = main;
    const title: JsonObject[] = [];
    node(main, "h3", "entry-title", "entry-title").children = title;
    title.push({ tag: "span", text: e.title });
    const link = contactLink(e.url);
    if (link) {
      node(title, "span", "sep", null).text = " | ";
      const a = node(title, "a", "entry-link", "link");
      a.attrs = { href: link.href };
      a.text = link.text;
    }
    const subtitle = join(" · ", e.subtitle, e.location);
    if (subtitle != null) node(main, "p", "entry-subtitle", "organization").text = subtitle;
    const when = dates(e.startDate, e.endDate, e.current);
    if (when != null) node(head, "p", "entry-dates", "date").text = when;

    if (e.description != null) {
      node(children, "p", "entry-description", null).html = richTextParagraphs(e.description).join("<br/>");
    }
    if (e.bullets.length > 0) {
      const bullets: JsonObject[] = [];
      node(children, "ul", "entry-highlights", null).children = bullets;
      for (const bullet of e.bullets) node(bullets, "li", null, "bullet").html = richTextToXhtml(bullet);
    }
  }
  return !first;
}

function list(s: Section, nodes: JsonObject[]) {
  const items = s.items.filter((item) => item.visible);
  if (items.length === 0) return false;
  const children: JsonObject[] = [];
  node(nodes, "ul", "list-items first", null).children = children;
  for (const item of items) {
    const li = node(children, "li", null, "bullet");
    li.id = item.id;
    li.html = richTextToXhtml(item.text);
  }
  return true;
}

function skills(s: Section, nodes: JsonObject[]) {
  let first = true;
  for (const g of s.groups) {
    if (!g.visible || (g.keywords.length === 0 && g.name == null)) continue;
    const group = node(nodes, "p", first ? "skill first" : "skill", "skill-group");
    first = false;
    group.id = g.id;
    const parts: JsonObject[] = [];
    group.children = parts;
    if (g.name != null) node(parts, "span", "skill-name", null).text = `${g.name}:`;
    parts.push({ tag: "span", text: (g.name != null ? " " : "") + g.keywords.join(", ") });
  }
  return !first;
}
