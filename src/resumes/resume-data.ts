import { z } from "zod";

import { FIELD_PLACEHOLDER, isAcceptableWebLink } from "../docengine/safe-urls.js";
import { ApiError } from "../http/errors.js";

/*
 * The resume JSON format (schema version 2): basics plus an ordered list of sections the user chooses.
 * Published as JSON Schema at GET /api/v1/resumes/schema so people and AI assistants can write it.
 * - Section `type` decides which field is used: entries (jobs, schools, projects…), text (paragraphs), list (bullet
 *   points) or skills (named groups of keywords).
 * - Sections and items carry ids so versions can be compared; missing ids are generated.
 * - Descriptions, bullets, list items and text allow **bold**, *italic* and [label](https://…) only (see rich-text.ts).
 * - Every string and list is capped so a single request can't produce an unbounded document.
 * - `layout` (optional) sets the page margins in millimetres.
 */

export const SCHEMA_VERSION = 2;
export const SECTION_TYPES = ["entries", "text", "list", "skills"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export type Link = { label: string | null; url: string | null };
export type Basics = {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  links: Link[];
};
export type Entry = {
  id: string;
  title: string;
  subtitle: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  url: string | null;
  description: string | null;
  bullets: string[];
  visible: boolean;
};
export type ListItem = { id: string; text: string; visible: boolean };
export type SkillGroup = { id: string; name: string | null; keywords: string[]; visible: boolean };
export type Section = {
  id: string;
  type: SectionType;
  title: string;
  visible: boolean;
  entries: Entry[];
  content: string | null;
  items: ListItem[];
  groups: SkillGroup[];
};
/** Page margins in millimetres (5–40); a missing value uses the template default (15 top, 16 elsewhere). */
export type Layout = {
  marginTop: number | null;
  marginRight: number | null;
  marginBottom: number | null;
  marginLeft: number | null;
};

/** A normalized resume: what is stored and returned. */
export type ResumeData = {
  schemaVersion: number;
  basics: Basics;
  sections: Section[];
  layout: Layout | null;
};

export const layoutTop = (l: Layout) => l.marginTop ?? 15;
export const layoutRight = (l: Layout) => l.marginRight ?? 16;
export const layoutBottom = (l: Layout) => l.marginBottom ?? 16;
export const layoutLeft = (l: Layout) => l.marginLeft ?? 16;

// ---- validation of user input (same rules and messages as the Spring backend) ----

const ID_MESSAGE = "may only use letters, digits, - and _";
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const size = (max: number) => `size must be between 0 and ${max}`;
const optional = (max: number) => z.string().max(max, size(max)).nullish();
const required = (max: number) =>
  z.string({ required_error: "is required", invalid_type_error: "is required" })
    .max(max, size(max))
    .refine((value) => value.trim() !== "", "is required");
const notBlank = (max: number) =>
  z.string({ invalid_type_error: "must not be blank" })
    .max(max, size(max))
    .refine((value) => value.trim() !== "", "must not be blank");
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max, size(max)).nullish();
const id = z.string().regex(ID, ID_MESSAGE).nullish();
const webLink = z.string().refine(isAcceptableWebLink, "must be a web address starting with http:// or https://");
/** Like Hibernate's @Email: empty is fine; otherwise local@domain, or a saved detail such as {{email}} (filled in when printed). */
const email = z.string().max(254, size(254))
  .refine((value) => value === "" || FIELD_PLACEHOLDER.test(value) || /^[^@\s]+@[^@\s]+$/.test(value),
    "must be an email address").nullish();
const margin = z.number()
  .min(5, "must be greater than or equal to 5")
  .max(40, "must be less than or equal to 40")
  .nullish();

const linkSchema = z.object({ label: optional(40), url: required(2048).pipe(webLink) });

export const resumeDataSchema = z.object({
  schemaVersion: z.number().int().nullish(),
  basics: z.object({
    fullName: required(100),
    headline: optional(150),
    email,
    phone: optional(40),
    location: optional(100),
    links: list(linkSchema, 6),
  }, { required_error: "is required", invalid_type_error: "is required" }),
  sections: list(z.object({
    id,
    type: z.enum(SECTION_TYPES, { required_error: "is required", message: `must be one of ${SECTION_TYPES.join(", ")}` }),
    title: required(60),
    visible: z.boolean().nullish(),
    entries: list(z.object({
      id,
      title: required(150),
      subtitle: optional(150),
      location: optional(100),
      startDate: optional(30),
      endDate: optional(30),
      current: z.boolean().nullish(),
      url: webLink.nullish(),
      description: optional(1500),
      bullets: list(notBlank(500), 20),
      visible: z.boolean().nullish(),
    }), 40),
    content: optional(4000),
    items: list(z.object({ id, text: required(500), visible: z.boolean().nullish() }), 50),
    groups: list(z.object({
      id,
      name: optional(60),
      keywords: list(notBlank(60), 50),
      visible: z.boolean().nullish(),
    }), 30),
  }), 25),
  layout: z.object({ marginTop: margin, marginRight: margin, marginBottom: margin, marginLeft: margin }).nullish(),
});

export type ResumeDataInput = z.infer<typeof resumeDataSchema>;

// ---- text cleaning shared by the resume formats ----

// Control characters (except tab and newline) and lone surrogates aren't valid in XML/PDF text
const UNPRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(UNPRINTABLE, "").replace(/[ \t\n\x0B\f\r]+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

export function cleanMultiline(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(UNPRINTABLE, "")
    .replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned === "" ? null : cleaned;
}

const lines = (values: unknown): string[] =>
  Array.isArray(values) ? values.map(clean).filter((value): value is string => value !== null) : [];

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objects = (values: unknown): Loose[] => (Array.isArray(values) ? values.filter(isObject) : []);
const isVisible = (value: unknown) => value !== false;
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function uniqueId(requested: unknown, fallback: string, used: Set<string>) {
  const candidate = typeof requested === "string" && ID.test(requested) ? requested : fallback;
  let unique = candidate;
  let n = 2;
  while (used.has(unique)) unique = `${candidate}-${n++}`;
  used.add(unique);
  return unique;
}

/**
 * A cleaned copy used before saving and rendering: text trimmed, unprintable characters removed, fields that don't
 * belong to a section's type dropped, empty items dropped, visible defaulted to true, and missing or duplicate ids
 * replaced with generated ones. Accepts loosely typed input (stored or imported JSON); wrong types count as missing.
 */
export function normalize(raw: unknown): ResumeData {
  const data = isObject(raw) ? raw : {};
  const b = isObject(data.basics) ? data.basics : {};
  const basics: Basics = {
    fullName: clean(b.fullName),
    headline: clean(b.headline),
    email: clean(b.email),
    phone: clean(b.phone),
    location: clean(b.location),
    links: objects(b.links).map((l) => ({ label: clean(l.label), url: clean(l.url) })).filter((l) => l.url !== null),
  };

  const usedIds = new Set<string>();
  const sections: Section[] = [];
  let sectionIndex = 0;
  for (const s of objects(data.sections)) {
    sectionIndex++;
    if (typeof s.type !== "string" || !(SECTION_TYPES as readonly string[]).includes(s.type)) continue;
    const type = s.type as SectionType;
    const sectionId = uniqueId(s.id, `s${sectionIndex}`, usedIds);
    let entries: Entry[] = [];
    let content: string | null = null;
    let items: ListItem[] = [];
    let groups: SkillGroup[] = [];
    if (type === "entries") {
      let i = 0;
      for (const e of objects(s.entries)) {
        i++;
        const title = clean(e.title);
        if (title === null) continue;
        const current = e.current === true;
        entries.push({
          id: uniqueId(e.id, `${sectionId}-e${i}`, usedIds),
          title,
          subtitle: clean(e.subtitle),
          location: clean(e.location),
          startDate: clean(e.startDate),
          endDate: current ? null : clean(e.endDate),
          current,
          url: clean(e.url),
          description: cleanMultiline(e.description),
          bullets: lines(e.bullets),
          visible: isVisible(e.visible),
        });
      }
    } else if (type === "text") {
      content = cleanMultiline(s.content);
    } else if (type === "list") {
      let i = 0;
      for (const item of objects(s.items)) {
        i++;
        const text = clean(item.text);
        if (text !== null) items.push({ id: uniqueId(item.id, `${sectionId}-i${i}`, usedIds), text, visible: isVisible(item.visible) });
      }
    } else {
      let i = 0;
      for (const g of objects(s.groups)) {
        i++;
        const keywords = lines(g.keywords);
        const name = clean(g.name);
        if (keywords.length > 0 || name !== null) {
          groups.push({ id: uniqueId(g.id, `${sectionId}-g${i}`, usedIds), name, keywords, visible: isVisible(g.visible) });
        }
      }
    }
    sections.push({ id: sectionId, type, title: clean(s.title) ?? "Section", visible: isVisible(s.visible), entries,
      content, items, groups });
  }

  let layout: Layout | null = null;
  if (isObject(data.layout)) {
    const l = data.layout;
    const candidate = { marginTop: finite(l.marginTop), marginRight: finite(l.marginRight),
      marginBottom: finite(l.marginBottom), marginLeft: finite(l.marginLeft) };
    if (Object.values(candidate).some((value) => value !== null)) layout = candidate;
  }
  return { schemaVersion: SCHEMA_VERSION, basics, sections, layout };
}

// ---- the first resume format (fixed sections), read only to convert it ----

const LEGACY_KEYS = ["summary", "experience", "education", "skills", "projects", "certifications", "languages"];

function isLegacy(node: Loose) {
  return !("sections" in node) && LEGACY_KEYS.some((key) => key in node);
}

/** The same resume as an ordered list of sections (schema version 2), in the order the old templates used. */
export function legacyToV2(d: Loose): ResumeData {
  const sections: Loose[] = [];
  const summary = cleanMultiline(d.summary);
  if (summary !== null) sections.push({ id: "summary", type: "text", title: "Summary", content: summary });
  const experience = objects(d.experience);
  if (experience.length > 0) {
    sections.push({ id: "experience", type: "entries", title: "Experience", entries: experience.map((e) => ({
      title: clean(e.title), subtitle: clean(e.organization), location: clean(e.location), startDate: clean(e.startDate),
      endDate: clean(e.endDate), current: e.current === true, bullets: lines(e.highlights),
    })) });
  }
  const projects = objects(d.projects);
  if (projects.length > 0) {
    sections.push({ id: "projects", type: "entries", title: "Projects", entries: projects.map((p) => {
      const technologies = lines(p.technologies);
      return { title: clean(p.name), subtitle: technologies.length > 0 ? technologies.join(", ") : null, url: clean(p.url),
        description: cleanMultiline(p.description), bullets: lines(p.highlights) };
    }) });
  }
  const education = objects(d.education);
  if (education.length > 0) {
    sections.push({ id: "education", type: "entries", title: "Education", entries: education.map((e) => {
      const degree = [clean(e.degree), clean(e.fieldOfStudy)].filter((part) => part !== null).join(", ");
      const institution = clean(e.institution);
      return { title: degree || institution, subtitle: degree ? institution : null, location: clean(e.location),
        startDate: clean(e.startDate), endDate: clean(e.endDate), description: clean(e.grade), bullets: lines(e.highlights) };
    }) });
  }
  const skills = objects(d.skills);
  if (skills.length > 0) {
    sections.push({ id: "skills", type: "skills", title: "Skills",
      groups: skills.map((g) => ({ name: clean(g.name), keywords: lines(g.items) })) });
  }
  const certifications = objects(d.certifications);
  if (certifications.length > 0) {
    sections.push({ id: "certifications", type: "entries", title: "Certifications", entries: certifications.map((c) => ({
      title: clean(c.name), subtitle: clean(c.issuer), endDate: clean(c.date), url: clean(c.url),
    })) });
  }
  const languages = objects(d.languages);
  if (languages.length > 0) {
    sections.push({ id: "languages", type: "list", title: "Languages", items: languages.map((l) => {
      const name = clean(l.name);
      const proficiency = clean(l.proficiency);
      return { text: proficiency === null ? name : `${name} (${proficiency})` };
    }) });
  }
  return normalize({ basics: d.basics, sections });
}

/**
 * Reads resume JSON in either format: schema version 2 (sections) or the original fixed-section format, which is
 * converted. Accepts a whole saved resume ({"data": {...}}) as well as the data itself. Not validated: callers
 * validate where input comes from users.
 */
export function readResumeJson(node: unknown): Loose {
  if (!isObject(node)) throw new ApiError(400, "INVALID_RESUME_JSON", "Resume JSON must be an object.");
  let data = node;
  if (!("basics" in data) && isObject(data.data)) data = data.data;
  return isLegacy(data) ? (legacyToV2(data) as unknown as Loose) : data;
}
