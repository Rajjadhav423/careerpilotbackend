import type { Doc, DocNode, Section as DocSection } from "../docengine/model.js";
import { normalize, type ResumeData } from "./resume-data.js";

/*
 * Reads a validated document back into the form's format (schema version 2), so a resume edited as a document can be
 * edited in the form again. Content comes back; styling stays in the document (see mergeDocument).
 *
 * Documents made from the form carry roles (name, headline, contact, entry, bullet, skill-group …) and are read
 * exactly. Hand-written documents are read by their shape:
 *   - an "entry" (role or class), or else each <h3> with what follows it → an entry
 *   - role skill-group paragraphs, or a two-column table (name | keywords) → skill groups
 *   - a bulleted/numbered list on its own → a list section
 *   - anything else → a paragraph section
 * Inline formatting becomes the form's markers: **bold**, *italic*, [label](https://…).
 */

/** Inline nodes as the form's formatting markers. */
function markdown(nodes: DocNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (!node.visible) continue;
    if (node.tag === "#text") out += node.text ?? "";
    else if (node.tag === "br") out += "\n";
    else {
      const inner = node.text != null ? node.text : markdown(node.children);
      if (!inner.trim()) continue;
      if (node.tag === "b" || node.tag === "strong") out += `**${inner}**`;
      else if (node.tag === "i" || node.tag === "em") out += `*${inner}*`;
      else if (node.tag === "a" && node.attrs.href && !node.attrs.href.startsWith("mailto:")) out += `[${inner}](${node.attrs.href})`;
      else out += inner;
    }
  }
  return out;
}

/** The node's own text with formatting markers (text, or its children). */
const textOf = (node: DocNode) => (node.text != null ? node.text : markdown(node.children)).replace(/[ \t]+/g, " ").trim();

/** Plain text, no markers. */
function plain(node: DocNode): string {
  if (node.text != null) return node.text;
  return node.children.map((child) => (child.tag === "br" ? " " : plain(child))).join("");
}

const isDate = (node: DocNode) =>
  node.role === "date" || node.classes.includes("date") || node.classes.includes("entry-dates") || node.style.float === "right";
const isSeparator = (node: DocNode) => node.classes.includes("sep");

/** All descendants, depth first. */
function* walk(nodes: DocNode[]): Generator<DocNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

const find = (nodes: DocNode[], test: (node: DocNode) => boolean) => {
  for (const node of walk(nodes)) if (test(node)) return node;
  return null;
};

type Dates = { startDate: string | null; endDate: string | null; current: boolean };

/** "Jan 2022 – Present" → start, end, current. */
function readDates(text: string | null): Dates {
  if (!text?.trim()) return { startDate: null, endDate: null, current: false };
  const [start, end] = text.split(/\s+[–—-]\s+/).map((part) => part.trim());
  if (end === undefined) return { startDate: null, endDate: start || null, current: false };
  const current = /^(present|current|now)$/i.test(end);
  return { startDate: start || null, endDate: current ? null : end || null, current };
}

const PHONE = /^\+?[\d\s().-]{7,}$/;

function readBasics(doc: Doc) {
  const all = doc.sections.flatMap((s) => s.nodes);
  const name = find(all, (n) => n.role === "name") ?? find(all, (n) => n.tag === "h1");
  const headline = find(all, (n) => n.role === "headline");
  const contact = find(all, (n) => n.role === "contact");
  const basics = {
    fullName: name ? plain(name).trim() : doc.meta.author,
    headline: headline ? plain(headline).trim() : null,
    email: null as string | null,
    phone: null as string | null,
    location: null as string | null,
    links: [] as { label: string | null; url: string }[],
  };
  if (contact) {
    const parts = contact.text != null ? contact.text.split("|").map((t) => ({ text: t.trim(), href: null as string | null }))
      : contact.children.filter((c) => !isSeparator(c) && c.tag !== "#text" || (c.tag === "#text" && (c.text ?? "").replace(/[|·\s]/g, "")))
        .map((c) => ({ text: plain(c).replace(/^[\s|·]+|[\s|·]+$/g, ""), href: c.attrs.href ?? null }));
    for (const part of parts) {
      if (!part.text) continue;
      if (part.href?.startsWith("mailto:")) basics.email = part.href.slice(7).split("?")[0] ?? part.text;
      else if (part.href) basics.links.push({ label: null, url: part.href });
      else if (/@/.test(part.text) && !basics.email) basics.email = part.text;
      else if (PHONE.test(part.text) && !basics.phone) basics.phone = part.text;
      else if (!basics.location) basics.location = part.text;
    }
  }
  return { basics, nameNode: name };
}

/** One entry from its nodes: a title line (with dates), subtitle, description and bullets. */
function readEntry(nodes: DocNode[], id: string | null, data: Record<string, unknown> | null) {
  const titleNode = find(nodes, (n) => n.role === "entry-title" || n.classes.includes("entry-title") || /^h[3-6]$/.test(n.tag));
  const dateNode = find(nodes, isDate);
  const linkNode = titleNode ? find(titleNode.children, (n) => n.tag === "a" && !!n.attrs.href) : null;
  let title = typeof data?.title === "string" ? data.title : null;
  if (!title && titleNode) {
    title = titleNode.text ?? titleNode.children
      .filter((c) => !isDate(c) && !isSeparator(c) && c !== linkNode)
      .map(plain).join("").trim();
  }
  const subtitleNode = find(nodes, (n) => n.role === "organization" || n.classes.includes("entry-subtitle"));
  const subtitleText = subtitleNode ? plain(subtitleNode).trim() : null;
  let subtitle = typeof data?.org === "string" ? data.org : null;
  let location: string | null = null;
  if (subtitleText) {
    if (subtitle && subtitleText.startsWith(subtitle)) location = subtitleText.slice(subtitle.length).replace(/^\s*·\s*/, "") || null;
    else if (!subtitle) subtitle = subtitleText;
  }
  // "Software Engineer · BrightCart" in the title with no separate subtitle: keep it as the title
  const description = find(nodes, (n) => n.classes.includes("entry-description"));
  const otherText = nodes.filter((n) => n.tag === "p" && n !== subtitleNode && n !== description && n !== titleNode
    && !find([n], isDate) && n.role !== "organization");
  const bullets = [...walk(nodes)].filter((n) => n.tag === "li").map(textOf).filter(Boolean);
  const descriptionText = [description, ...otherText].filter((n): n is DocNode => !!n).map(textOf).filter(Boolean).join("\n\n");
  return {
    id,
    title: title || "Untitled",
    subtitle,
    location,
    ...readDates(dateNode ? plain(dateNode) : null),
    url: linkNode?.attrs.href ?? null,
    description: descriptionText || null,
    bullets,
  };
}

function readSection(section: DocSection, nameNode: DocNode | null) {
  // Section title: its h2 (or role section-title); that node isn't content
  const heading = section.nodes.find((n) => n.role === "section-title" || n.tag === "h2") ?? null;
  const title = section.title ?? (heading ? plain(heading).trim() : null) ?? section.id;
  const nodes = section.nodes.filter((n) => n !== heading);
  const base = { id: section.id, title, visible: section.visible };

  const entryNodes = nodes.filter((n) => n.role === "entry" || n.classes.includes("entry"));
  if (entryNodes.length > 0) {
    return { ...base, type: "entries", entries: entryNodes.map((n) => ({
      ...readEntry(n.children.length > 0 ? n.children : [n], n.id, n.data as Record<string, unknown> | null),
      visible: n.visible,
    })) };
  }

  const skillNodes = nodes.filter((n) => n.role === "skill-group" || n.classes.includes("skill"));
  if (skillNodes.length > 0) {
    return { ...base, type: "skills", groups: skillNodes.map((n) => {
      const nameSpan = n.children.find((c) => c.classes.includes("skill-name"));
      const rest = nameSpan ? n.children.filter((c) => c !== nameSpan).map(plain).join("") : plain(n);
      return { id: n.id, name: nameSpan ? plain(nameSpan).replace(/:\s*$/, "").trim() : null,
        keywords: rest.split(",").map((k) => k.trim()).filter(Boolean), visible: n.visible };
    }) };
  }

  const table = nodes.length === 1 && nodes[0]!.tag === "table" ? nodes[0]! : null;
  if (table) {
    const rows = [...walk([table])].filter((n) => n.tag === "tr");
    if (rows.every((r) => r.children.length === 2)) {
      return { ...base, type: "skills", groups: rows.map((r) => ({
        id: r.id, name: plain(r.children[0]!).replace(/:\s*$/, "").trim() || null,
        keywords: plain(r.children[1]!).split(",").map((k) => k.trim()).filter(Boolean), visible: r.visible,
      })) };
    }
  }

  const headings = nodes.filter((n) => /^h[3-6]$/.test(n.tag));
  if (headings.length > 0 && nodes[0] && /^h[3-6]$/.test(nodes[0].tag)) {
    // Each heading starts an entry; everything until the next heading belongs to it
    const groups: DocNode[][] = [];
    for (const node of nodes) {
      if (/^h[3-6]$/.test(node.tag)) groups.push([node]);
      else groups.at(-1)?.push(node);
    }
    return { ...base, type: "entries", entries: groups.map((g) => ({ ...readEntry(g, g[0]!.id, null), visible: true })) };
  }

  const lists = nodes.filter((n) => n.tag === "ul" || n.tag === "ol");
  if (lists.length > 0 && nodes.every((n) => n.tag === "ul" || n.tag === "ol")) {
    return { ...base, type: "list", items: lists.flatMap((l) => l.children).filter((li) => li.tag === "li")
      .map((li) => ({ id: li.id, text: textOf(li), visible: li.visible })) };
  }

  // Free text: each block becomes a paragraph; list items become "- " lines
  const paragraphs: string[] = [];
  for (const node of nodes) {
    if (node === nameNode) continue;
    if (node.tag === "ul" || node.tag === "ol") {
      paragraphs.push(node.children.map((li) => `- ${textOf(li)}`).join("\n"));
    } else {
      const text = textOf(node);
      if (text) paragraphs.push(text);
    }
  }
  return { ...base, type: "text", content: paragraphs.join("\n\n") || null };
}

/** The document's content as form data. The section holding the name (the header) becomes the basics. */
export function docToResume(doc: Doc): ResumeData {
  const { basics, nameNode } = readBasics(doc);
  const sections = doc.sections
    .filter((section) => !(nameNode && find(section.nodes, (n) => n === nameNode)))
    .map((section) => readSection(section, nameNode));
  const [top, right, bottom, left] = doc.page.margin.split(" ").map((v) => Number.parseFloat(v));
  // The template default (15 / 16 / 16 / 16 mm) stays unset in the form
  const isDefault = top === 15 && right === 16 && bottom === 16 && left === 16;
  return normalize({
    basics,
    sections,
    layout: isDefault ? null : { marginTop: top, marginRight: right, marginBottom: bottom, marginLeft: left },
  });
}
