import { abbreviate, checkCss, contrastWarning, passed } from "./css-rules.js";
import { parseInlineHtml } from "./inline-html.js";
import type { Doc, DocKind, DocNode, Meta, Page, PageSize, Section, StyleMap } from "./model.js";
import { documentLink, MAX_URL_LENGTH } from "./safe-urls.js";

/*
 * Reads and validates document JSON against doc-rules.md.
 * - STRICT (API): every broken rule is an error and no document is returned.
 * - LENIENT (UI import): fixable problems are repaired (unknown fields dropped, bad tags unwrapped, invalid CSS
 *   removed, long text cut…) and reported as warnings; the result is always valid.
 * Paths in issues are JSON Pointers (RFC 6901), e.g. /sections/1/nodes/0/style/display.
 */

export type ReadMode = "STRICT" | "LENIENT";
export type Issue = { path: string; code: string; message: string };
export type ReadResult = { doc: Doc | null; errors: Issue[]; warnings: Issue[] };

/** Preset id → its styles (selector → declarations). */
export type PresetStyles = Record<string, Record<string, StyleMap>>;

// ---- limits (doc-rules.md §11) ----
export const MAX_SECTIONS = 50;
export const MAX_NODES = 2000;
export const MAX_DEPTH = 12;
export const MAX_CHILDREN = 200;
export const MAX_TEXT = 5000;
export const MAX_STYLE_RULES = 100;
export const MAX_DECLARATIONS = 40;
export const MAX_PAGES = 10;

// ---- tags (doc-rules.md §6) ----
export const INLINE = new Set(["span", "strong", "b", "em", "i", "u", "s", "small", "mark", "sub", "sup", "code",
  "abbr", "time", "a", "br"]);
/** Blocks whose content is inline only (text, html or inline children). */
export const TEXT_BLOCKS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "address", "dt"]);
/** Blocks that may contain other blocks as well as inline content. */
export const CONTAINERS = new Set(["div", "section", "header", "footer", "article", "aside", "blockquote", "li", "dd",
  "td", "th"]);
const STRUCTURE: Record<string, string[]> = {
  ul: ["li"], ol: ["li"], dl: ["dt", "dd"],
  table: ["thead", "tbody", "tfoot", "tr"],
  thead: ["tr"], tbody: ["tr"], tfoot: ["tr"],
  tr: ["th", "td"],
};
const PARENTS: Record<string, string[]> = {
  li: ["ul", "ol"], dt: ["dl"], dd: ["dl"],
  thead: ["table"], tbody: ["table"], tfoot: ["table"],
  tr: ["table", "thead", "tbody", "tfoot"], th: ["tr"], td: ["tr"],
};
export const BLOCKED_TAGS = new Set(["script", "style", "link", "meta", "iframe", "frame", "frameset", "object",
  "embed", "form", "input", "button", "select", "option", "textarea", "svg", "math", "video", "audio", "canvas",
  "base", "img", "picture", "source", "noscript", "template", "html", "head", "body", "title"]);
export const ROLES = new Set(["name", "headline", "contact", "section-title", "summary", "entry", "entry-title",
  "organization", "date", "bullet", "skill-group", "link", "letter-recipient", "letter-date", "letter-subject",
  "letter-salutation", "letter-body", "letter-closing", "signature"]);

const ROOT_KEYS = ["schemaVersion", "document", "preset", "meta", "page", "styles", "sections"];
const SECTION_KEYS = ["id", "title", "visible", "style", "nodes"];
const NODE_KEYS = ["id", "tag", "class", "style", "attrs", "visible", "text", "html", "children", "role", "data"];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CLASS = /^[a-z][a-z0-9-]{0,39}$/;
const SELECTOR = /^(body|[a-z][a-z0-9]{0,9})?(?:\.([a-z][a-z0-9-]{0,39}))?$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const DATA_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,30}$/;
const MARGIN = /^(\d{1,3}(?:\.\d{1,2})?)(mm|cm|in|pt|px)?$/;

export const DEFAULT_MARGIN = "15mm 16mm 16mm 16mm";

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: Json): value is string => typeof value === "string";
const isNumber = (value: Json): value is number => typeof value === "number" && Number.isFinite(value);
const present = (value: Json) => (value === undefined || value === null ? undefined : value);
const sorted = (values: Iterable<string>) => [...values].sort();
/** Escapes a key for a JSON Pointer. */
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

export const isKnownTag = (tag: string) =>
  INLINE.has(tag) || TEXT_BLOCKS.has(tag) || CONTAINERS.has(tag) || tag in STRUCTURE || tag === "hr";

/** Section level (null) and containers accept blocks; everything else holds inline content only. */
const allowsBlock = (parentTag: string | null) => parentTag === null || CONTAINERS.has(parentTag) || parentTag in STRUCTURE;

/** "12mm 16mm" → "12mm 16mm 12mm 16mm" (all in mm, 0–40); null if invalid. */
export function normaliseMargin(value: string): string | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return null;
  const mm: number[] = [];
  for (const part of parts) {
    const m = MARGIN.exec(part.toLowerCase());
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] ?? "mm";
    const value = unit === "cm" ? n * 10 : unit === "in" ? n * 25.4 : unit === "pt" ? (n * 25.4) / 72
      : unit === "px" ? (n * 25.4) / 96 : n;
    if (value > 40.001) return null;
    mm.push(value);
  }
  const top = mm[0]!;
  const right = mm[1] ?? top;
  const bottom = mm[2] ?? top;
  const left = mm[3] ?? right;
  return [top, right, bottom, left].map((v) => `${num(v)}mm`).join(" ");
}

function num(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** presets: style presets by id ("classic" → its styles); a document may name one. */
export function readDoc(json: Json, mode: ReadMode, presets: PresetStyles = {}): ReadResult {
  const reader = new Reader(mode, presets);
  const doc = reader.root(json);
  reader.classWarnings();
  const ok = reader.errors.length === 0;
  return { doc: ok ? doc : null, errors: reader.errors, warnings: reader.warnings };
}

class Reader {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  private readonly ids = new Set<string>();
  private readonly definedClasses = new Set<string>();
  private readonly usedClasses: [string, string][] = [];
  private nodeCount = 0;
  private generatedIds = 0;

  constructor(
    private readonly mode: ReadMode,
    private readonly presets: PresetStyles,
  ) {}

  // ---- issues ----

  /** A broken rule: an error in strict mode; repaired with a warning in lenient mode. */
  private problem(path: string, code: string, message: string) {
    (this.mode === "STRICT" ? this.errors : this.warnings).push({ path, code, message });
  }

  private fatal(path: string, code: string, message: string) {
    this.errors.push({ path, code, message });
  }

  private warn(path: string, code: string, message: string) {
    this.warnings.push({ path, code, message });
  }

  // ---- document ----

  root(json: Json): Doc | null {
    if (!isObject(json)) {
      this.fatal("", "NOT_AN_OBJECT", "The document must be a JSON object.");
      return null;
    }
    this.unknownKeys(json, ROOT_KEYS, "");

    const version = json.schemaVersion;
    if (!isNumber(version) || Math.trunc(version) !== 3) {
      this.problem("/schemaVersion", "SCHEMA_VERSION", "Set \"schemaVersion\": 3.");
    }

    let kind: DocKind = "resume";
    const documentKind = json.document;
    if (!isString(documentKind) || !["resume", "coverLetter"].includes(documentKind)) {
      this.problem("/document", "DOCUMENT_KIND", "Set \"document\" to \"resume\" or \"coverLetter\".");
    } else {
      kind = documentKind as DocKind;
    }

    let preset: string | null = null;
    const presetNode = present(json.preset);
    if (presetNode !== undefined) {
      if (isString(presetNode) && Object.hasOwn(this.presets, presetNode)) {
        preset = presetNode;
        for (const selector of Object.keys(this.presets[preset]!)) this.defineClass(selector);
      } else {
        this.problem("/preset", "PRESET_UNKNOWN", `Unknown preset. Use one of: ${Object.keys(this.presets).join(", ")}.`);
      }
    }

    const meta = this.meta(json.meta);
    const page = this.page(json.page);
    const styles = this.styles(json.styles);
    const sections = this.sections(json.sections);
    return { schemaVersion: 3, document: kind, preset, meta, page, styles, sections };
  }

  private meta(node: Json): Meta {
    const fallback: Meta = { title: null, author: null, subject: null, language: "en" };
    if (present(node) === undefined) return fallback;
    if (!isObject(node)) {
      this.problem("/meta", "WRONG_TYPE", "\"meta\" must be an object.");
      return fallback;
    }
    this.unknownKeys(node, ["title", "author", "subject", "language"], "/meta");
    let language = this.string(node.language, "/meta/language", 20);
    if (language !== null && !LANGUAGE.test(language)) {
      this.problem("/meta/language", "LANGUAGE_INVALID", "Use a language code like \"en\" or \"en-IN\".");
      language = null;
    }
    return {
      title: this.string(node.title, "/meta/title", 200),
      author: this.string(node.author, "/meta/author", 100),
      subject: this.string(node.subject, "/meta/subject", 200),
      language: language ?? "en",
    };
  }

  private page(node: Json): Page {
    let size: PageSize = "A4";
    let margin = DEFAULT_MARGIN;
    let maxPages = MAX_PAGES;
    let pageNumbers = true;
    if (present(node) === undefined) return { size, margin, maxPages, pageNumbers };
    if (!isObject(node)) {
      this.problem("/page", "WRONG_TYPE", "\"page\" must be an object.");
      return { size, margin, maxPages, pageNumbers };
    }
    this.unknownKeys(node, ["size", "margin", "maxPages", "pageNumbers"], "/page");
    const sizeNode = present(node.size);
    if (sizeNode !== undefined) {
      const value = (isString(sizeNode) ? sizeNode : "").toUpperCase();
      if (value === "A4" || value === "LETTER") size = value;
      else this.problem("/page/size", "PAGE_SIZE", "Use \"A4\" or \"LETTER\".");
    }
    const marginNode = present(node.margin);
    if (marginNode !== undefined) {
      const parsed = isString(marginNode) || isNumber(marginNode) ? normaliseMargin(String(marginNode)) : null;
      if (parsed === null) this.problem("/page/margin", "PAGE_MARGIN", "Use 1–4 lengths from 0 to 40mm, e.g. \"15mm 16mm\".");
      else margin = parsed;
    }
    const max = present(node.maxPages);
    if (max !== undefined) {
      if (isNumber(max) && Number.isInteger(max) && max >= 1 && max <= MAX_PAGES) maxPages = max;
      else this.problem("/page/maxPages", "MAX_PAGES", `maxPages must be a whole number from 1 to ${MAX_PAGES}.`);
    }
    const numbers = present(node.pageNumbers);
    if (numbers !== undefined) {
      if (typeof numbers === "boolean") pageNumbers = numbers;
      else this.problem("/page/pageNumbers", "WRONG_TYPE", "pageNumbers must be true or false.");
    }
    return { size, margin, maxPages, pageNumbers };
  }

  // ---- styles ----

  private styles(node: Json): Record<string, StyleMap> {
    const styles: Record<string, StyleMap> = {};
    if (present(node) === undefined) return styles;
    if (!isObject(node)) {
      this.problem("/styles", "WRONG_TYPE", "\"styles\" must be an object of selector → declarations.");
      return styles;
    }
    let count = 0;
    for (const [key, value] of Object.entries(node)) {
      const selector = key.trim();
      const path = `/styles/${pointer(key)}`;
      if (++count > MAX_STYLE_RULES) {
        this.problem(path, "TOO_MANY_STYLES", `At most ${MAX_STYLE_RULES} style rules; the rest were ignored.`);
        break;
      }
      const m = SELECTOR.exec(selector);
      const valid = selector !== "" && m !== null && (m[1] === undefined || m[1] === "body" || isKnownTag(m[1]));
      if (!valid || m === null) {
        this.problem(path, "SELECTOR_INVALID", `Selector "${abbreviate(selector)}" isn't allowed. `
          + "Use body, a tag (h2), a class (.muted) or both (li.tight).");
        continue;
      }
      if (m[2] !== undefined) this.definedClasses.add(m[2]);
      styles[selector] = this.declarations(value, path);
    }
    return styles;
  }

  private defineClass(selector: string) {
    const dot = selector.indexOf(".");
    if (dot >= 0) this.definedClasses.add(selector.slice(dot + 1));
  }

  /** A style object: property → value (string or number). Invalid declarations are dropped or rejected. */
  private declarations(node: Json, path: string): StyleMap {
    const style: StyleMap = {};
    if (present(node) === undefined) return style;
    if (!isObject(node)) {
      this.problem(path, "WRONG_TYPE", "A style must be an object like { \"color\": \"#1f2328\" }.");
      return style;
    }
    let count = 0;
    for (const [key, value] of Object.entries(node)) {
      const property = key.trim().toLowerCase();
      const propertyPath = `${path}/${pointer(key)}`;
      if (++count > MAX_DECLARATIONS) {
        this.problem(propertyPath, "TOO_MANY_DECLARATIONS", `At most ${MAX_DECLARATIONS} properties per style.`);
        break;
      }
      if (!(isString(value) || isNumber(value))) {
        this.problem(propertyPath, "CSS_VALUE_INVALID", "CSS values must be strings, e.g. \"10pt\".");
        continue;
      }
      const check = checkCss(property, String(value));
      if (passed(check)) style[property] = check.value!;
      else this.problem(propertyPath, check.code!, check.message!);
    }
    const contrast = contrastWarning(style);
    if (contrast) this.warn(`${path}/color`, "LOW_CONTRAST", contrast);
    return style;
  }

  // ---- sections ----

  private sections(node: Json): Section[] {
    const sections: Section[] = [];
    if (!Array.isArray(node)) {
      this.problem("/sections", "MISSING_SECTIONS", "Add \"sections\": an array of sections.");
      return sections;
    }
    if (node.length === 0) this.problem("/sections", "MISSING_SECTIONS", "Add at least one section.");
    for (let index = 0; index < node.length; index++) {
      const path = `/sections/${index}`;
      if (sections.length >= MAX_SECTIONS) {
        this.problem(path, "TOO_MANY_SECTIONS", `At most ${MAX_SECTIONS} sections; the rest were ignored.`);
        break;
      }
      const read = this.section(node[index], path, sections.length);
      if (read) sections.push(read);
    }
    return sections;
  }

  private section(node: Json, path: string, index: number): Section | null {
    if (!isObject(node)) {
      this.problem(path, "WRONG_TYPE", "A section must be an object with \"id\" and \"nodes\".");
      return null;
    }
    this.unknownKeys(node, SECTION_KEYS, path);
    const id = this.id(node.id, `${path}/id`, true, `s${index + 1}`)!;
    const title = this.string(node.title, `${path}/title`, 100);
    const visible = this.bool(node.visible, `${path}/visible`, true);
    const style = this.declarations(node.style, `${path}/style`);
    let nodes: DocNode[] = [];
    const list = present(node.nodes);
    if (list !== undefined) {
      if (!Array.isArray(list)) this.problem(`${path}/nodes`, "WRONG_TYPE", "\"nodes\" must be an array.");
      else nodes = this.nodeList(list, `${path}/nodes`, null, 1);
    }
    return { id, title, visible, style, nodes };
  }

  // ---- nodes ----

  private nodeList(array: Json[], path: string, parentTag: string | null, depth: number): DocNode[] {
    const nodes: DocNode[] = [];
    for (let index = 0; index < array.length; index++) {
      const childPath = `${path}/${index}`;
      if (nodes.length >= MAX_CHILDREN) {
        this.problem(childPath, "TOO_MANY_CHILDREN", `At most ${MAX_CHILDREN} children per element; the rest were ignored.`);
        break;
      }
      const node = this.node(array[index], childPath, parentTag, depth);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  private node(json: Json, path: string, parentTag: string | null, depth: number): DocNode | null {
    if (!isObject(json)) {
      this.problem(path, "WRONG_TYPE", "A node must be an object like { \"tag\": \"p\", \"text\": \"…\" }.");
      return null;
    }
    if (depth > MAX_DEPTH) {
      this.problem(path, "TOO_DEEP", `Elements can be nested at most ${MAX_DEPTH} levels deep; this one was removed.`);
      return null;
    }
    if (++this.nodeCount > MAX_NODES) {
      if (this.nodeCount === MAX_NODES + 1) {
        this.problem(path, "TOO_MANY_NODES", `At most ${MAX_NODES} nodes in a document; the rest were ignored.`);
      }
      return null;
    }
    this.unknownKeys(json, NODE_KEYS, path);

    let tag = this.tag(json.tag, path, parentTag);
    if (tag === null) return null;

    const id = this.id(json.id, `${path}/id`, false, null);
    const classes = this.classes(json.class, `${path}/class`);
    const style = this.declarations(json.style, `${path}/style`);
    const visible = this.bool(json.visible, `${path}/visible`, true);
    const role = this.role(json.role, `${path}/role`);
    const data = this.data(json.data, `${path}/data`);

    const acceptsContent = (INLINE.has(tag) && tag !== "br") || TEXT_BLOCKS.has(tag) || CONTAINERS.has(tag);
    let textNode = present(json.text);
    let htmlNode = present(json.html);
    let childrenNode = present(json.children);
    const contentFields = [textNode, htmlNode, childrenNode].filter((value) => value !== undefined).length;
    if (contentFields > 1) {
      this.problem(path, "CONTENT_CONFLICT", "Use only one of \"text\", \"html\" or \"children\" (kept "
        + `${childrenNode !== undefined ? "children" : "html"}).`);
      if (childrenNode !== undefined) htmlNode = undefined;
      textNode = undefined;
    }
    const structural = tag in STRUCTURE;
    if (!acceptsContent && (textNode !== undefined || htmlNode !== undefined || (childrenNode !== undefined && !structural))) {
      this.problem(path, "CONTENT_NOT_ALLOWED", `<${tag}> can't have ${structural ? "text" : "content"}`
        + (structural ? `; put it in ${STRUCTURE[tag]!.join("/")} children.` : "."));
      textNode = undefined;
      htmlNode = undefined;
      if (!structural) childrenNode = undefined;
    }

    let text: string | null = null;
    let html: string | null = null;
    let children: DocNode[] = [];
    if (textNode !== undefined) {
      text = this.text(textNode, `${path}/text`);
    } else if (htmlNode !== undefined) {
      const raw = this.text(htmlNode, `${path}/html`);
      if (raw !== null) {
        const parsed = parseInlineHtml(raw);
        for (const p of parsed.problems) this.problem(`${path}/html`, p.code, p.message);
        html = parsed.html;
        children = parsed.nodes;
      }
    } else if (childrenNode !== undefined) {
      if (!Array.isArray(childrenNode)) {
        this.problem(`${path}/children`, "WRONG_TYPE", "\"children\" must be an array of nodes.");
      } else {
        children = this.nodeList(childrenNode, `${path}/children`, tag, depth + 1);
      }
    }

    const attrs = this.attrs(json.attrs, `${path}/attrs`, tag);
    if (tag === "a" && attrs.href === undefined) {
      this.problem(`${path}/attrs/href`, "LINK_MISSING_HREF",
        "A link needs \"attrs\": { \"href\": \"https://…\" }; shown as text.");
      tag = "span";
    }
    return { id, tag, classes, style, attrs, visible, text, html, children, role, data };
  }

  /** The tag, checked against the allowlist and its parent. Lenient mode substitutes a safe tag. */
  private tag(node: Json, path: string, parentTag: string | null): string | null {
    const tagPath = `${path}/tag`;
    if (!isString(node) || node.trim() === "") {
      // Lenient: a node without a tag is removed (AI replies sometimes contain stray objects)
      this.problem(tagPath, "TAG_MISSING", "Every node needs a \"tag\", e.g. \"p\"; this one was removed.");
      return null;
    }
    let tag = node.trim().toLowerCase();
    if (BLOCKED_TAGS.has(tag)) {
      this.problem(tagPath, "TAG_BLOCKED", `<${tag}> isn't allowed in documents${blockedHint(tag)}; the node was removed.`);
      return null;
    }
    if (!isKnownTag(tag)) {
      this.problem(tagPath, "TAG_UNKNOWN", `<${abbreviate(tag)}> isn't a supported tag.`);
      tag = parentTag !== null && !allowsBlock(parentTag) ? "span" : "div";
    }
    const requiredParents = PARENTS[tag];
    if (requiredParents && (parentTag === null || !requiredParents.includes(parentTag))) {
      this.problem(tagPath, "TAG_WRONG_PARENT", `<${tag}> must be inside `
        + `${sorted(requiredParents).map((p) => `<${p}>`).join(" or ")}.`);
      return parentTag !== null && !allowsBlock(parentTag) ? "span" : "div";
    }
    if (parentTag !== null) {
      const allowedChildren = STRUCTURE[parentTag];
      if (allowedChildren && !allowedChildren.includes(tag)) {
        this.problem(tagPath, "TAG_WRONG_CHILD", `<${parentTag}> may only contain `
          + `${sorted(allowedChildren).map((c) => `<${c}>`).join(", ")}.`);
        // Lenient: keep the content as a list item; misplaced table parts are dropped
        return parentTag === "ul" || parentTag === "ol" ? "li" : parentTag === "dl" ? "dd" : null;
      }
      if (!allowsBlock(parentTag) && !INLINE.has(tag)) {
        this.problem(tagPath, "BLOCK_IN_INLINE",
          `<${tag}> can't be inside <${parentTag}>, which holds inline content only; it's printed as <span>.`);
        return "span";
      }
      if (tag === "a" && parentTag === "a") {
        this.problem(tagPath, "LINK_IN_LINK", "A link can't contain another link.");
        return "span";
      }
    }
    return tag;
  }

  private attrs(node: Json, path: string, tag: string): StyleMap {
    const attrs: StyleMap = {};
    if (present(node) === undefined) return attrs;
    if (!isObject(node)) {
      this.problem(path, "WRONG_TYPE", "\"attrs\" must be an object.");
      return attrs;
    }
    for (const [key, raw] of Object.entries(node)) {
      const name = key.toLowerCase();
      const attrPath = `${path}/${pointer(key)}`;
      const value = isString(raw) || isNumber(raw) ? String(raw).trim() : null;
      if (value === null) {
        this.problem(attrPath, "ATTR_INVALID", "Attribute values must be strings or numbers.");
        continue;
      }
      const checked = this.attribute(tag, name, value, attrPath);
      if (checked !== null) attrs[name] = checked;
    }
    return attrs;
  }

  private attribute(tag: string, name: string, value: string, path: string): string | null {
    switch (name) {
      case "href":
        if (tag === "a") {
          const link = documentLink(value);
          if (link === null) {
            this.problem(path, "UNSAFE_LINK",
              `Only https, http, mailto and tel links are allowed (max ${MAX_URL_LENGTH} characters).`);
          }
          return link;
        }
        break;
      case "title":
        if ((tag === "a" || tag === "abbr") && value.length <= 200) return value;
        break;
      case "colspan":
      case "rowspan":
        if (tag === "td" || tag === "th") return this.wholeNumber(value, 1, 20, path) ? value : null;
        break;
      case "start":
        if (tag === "ol") return this.wholeNumber(value, 1, 1000, path) ? value : null;
        break;
      case "type":
        if (tag === "ol") {
          if (["1", "a", "A", "i", "I"].includes(value)) return value;
          this.problem(path, "ATTR_INVALID", "type must be 1, a, A, i or I.");
          return null;
        }
        break;
      case "datetime":
        if (tag === "time" && /^[0-9T:+\-.Z ]{4,40}$/.test(value)) return value;
        break;
      case "lang":
        if (LANGUAGE.test(value)) return value;
        break;
      default:
        break;
    }
    this.problem(path, name.startsWith("on") ? "ATTR_BLOCKED" : "ATTR_NOT_ALLOWED", `Attribute "${name}" isn't allowed on <`
      + `${tag}>${name === "style" ? "; use the node's \"style\" field." : name === "class"
        ? "; use the node's \"class\" field." : "."}`);
    return null;
  }

  private wholeNumber(value: string, min: number, max: number, path: string) {
    if (/^\d{1,4}$/.test(value) && Number(value) >= min && Number(value) <= max) return true;
    this.problem(path, "ATTR_INVALID", `Must be a whole number from ${min} to ${max}.`);
    return false;
  }

  private classes(node: Json, path: string): string[] {
    if (present(node) === undefined) return [];
    let names: string[];
    if (isString(node)) {
      names = node.trim().split(/\s+/).filter(Boolean);
    } else if (Array.isArray(node)) {
      names = node.map((value) => (isString(value) ? value : ""));
    } else {
      this.problem(path, "WRONG_TYPE", "\"class\" must be a string like \"muted tight\".");
      return [];
    }
    const valid: string[] = [];
    for (const name of names) {
      if (CLASS.test(name)) {
        if (!valid.includes(name)) {
          valid.push(name);
          this.usedClasses.push([path, name]);
        }
      } else {
        this.problem(path, "CLASS_INVALID",
          `Class "${abbreviate(name)}" must be lower-case letters, digits and dashes, starting with a letter.`);
      }
    }
    return valid;
  }

  classWarnings() {
    for (const [path, name] of this.usedClasses) {
      if (!this.definedClasses.has(name)) {
        this.warn(path, "CLASS_UNDEFINED", `Class "${name}" isn't defined in "styles" (or the preset).`);
      }
    }
  }

  private role(node: Json, path: string): string | null {
    if (present(node) === undefined) return null;
    if (isString(node) && ROLES.has(node)) return node;
    this.problem(path, "ROLE_UNKNOWN", `Unknown role. Use one of: ${sorted(ROLES).join(", ")}.`);
    return null;
  }

  /** data: flat facts about the node (no effect on rendering). Dates in start/end are YYYY or YYYY-MM. */
  private data(node: Json, path: string): Json {
    if (present(node) === undefined) return null;
    if (!isObject(node) || Object.keys(node).length > 20) {
      this.problem(path, "DATA_INVALID", "\"data\" must be an object with at most 20 fields.");
      return null;
    }
    for (const [key, value] of Object.entries(node)) {
      const fieldPath = `${path}/${pointer(key)}`;
      const scalar = value === null || typeof value === "boolean" || isNumber(value)
        || (isString(value) && value.length <= 300);
      if (!DATA_KEY.test(key) || !scalar) {
        this.problem(fieldPath, "DATA_INVALID",
          "data fields need simple names and values (text up to 300 characters, numbers, true/false or null).");
        return null;
      }
      if ((key === "start" || key === "end") && isString(value) && !DATE.test(value)) {
        this.problem(fieldPath, "DATA_DATE_FORMAT", "Dates in data use YYYY or YYYY-MM, e.g. \"2022-01\" (null = present).");
        return null;
      }
    }
    return node;
  }

  // ---- small values ----

  private id(node: Json, path: string, required: boolean, fallback: string | null): string | null {
    const value = present(node) === undefined ? null : isString(node) ? node : isNumber(node) || typeof node === "boolean"
      ? String(node) : "";
    if (value === null) {
      if (required) {
        this.problem(path, "ID_MISSING", "Sections need an \"id\" like \"experience\".");
        return this.unique(fallback!);
      }
      return null;
    }
    if (!ID.test(value)) {
      this.problem(path, "ID_INVALID", "Ids use letters, digits, - and _ (1–40 characters).");
      return required ? this.unique(fallback!) : null;
    }
    if (this.ids.has(value)) {
      this.problem(path, "ID_DUPLICATE", `Id "${value}" is used twice; ids must be unique.`);
      return required ? this.unique(fallback!) : null;
    }
    this.ids.add(value);
    return value;
  }

  private unique(base: string) {
    let candidate = base;
    while (this.ids.has(candidate)) candidate = `${base}-${++this.generatedIds}`;
    this.ids.add(candidate);
    return candidate;
  }

  private text(node: Json, path: string): string | null {
    if (!(isString(node) || isNumber(node) || typeof node === "boolean")) {
      this.problem(path, "WRONG_TYPE", "Text must be a string.");
      return null;
    }
    let value = String(node);
    if (value.length > MAX_TEXT) {
      this.problem(path, "TEXT_TOO_LONG", `At most ${MAX_TEXT} characters per node; the rest was cut.`);
      value = value.slice(0, MAX_TEXT);
    }
    return value;
  }

  private string(node: Json, path: string, max: number): string | null {
    if (present(node) === undefined) return null;
    if (!isString(node)) {
      this.problem(path, "WRONG_TYPE", "Must be a string.");
      return null;
    }
    let value = node.trim();
    if (value.length > max) {
      this.problem(path, "TEXT_TOO_LONG", `At most ${max} characters.`);
      value = value.slice(0, max);
    }
    return value === "" ? null : value;
  }

  private bool(node: Json, path: string, fallback: boolean): boolean {
    if (present(node) === undefined) return fallback;
    if (typeof node !== "boolean") {
      this.problem(path, "WRONG_TYPE", "Must be true or false.");
      return fallback;
    }
    return node;
  }

  private unknownKeys(node: JsonObject, known: string[], path: string) {
    for (const name of Object.keys(node)) {
      if (!known.includes(name)) {
        this.problem(`${path}/${pointer(name)}`, "UNKNOWN_FIELD", `Unknown field "${abbreviate(name)}". `
          + `Allowed here: ${sorted(known).join(", ")}.`);
      }
    }
  }
}

function blockedHint(tag: string) {
  switch (tag) {
    case "img":
    case "picture":
    case "svg":
      return " (images aren't supported yet)";
    case "style":
    case "link":
      return " (use \"styles\" and \"style\" instead)";
    case "script":
    case "noscript":
    case "template":
      return " (no scripts in documents)";
    default:
      return "";
  }
}
