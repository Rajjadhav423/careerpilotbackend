import { fontFamilies, resolveFont } from "./fonts.js";

/*
 * The CSS a document may use (see doc-rules.md §8). Every property is on an allowlist with its own value check;
 * anything that could fetch a resource (url()), run code, escape the page or break the CSS syntax is refused.
 * Values that pass are normalized (trimmed, lower-case keywords and units) and are safe to print inside a <style>
 * element or a style attribute.
 */

/** A value that passed (code === null) or a reason it didn't. */
export type Check = { value: string | null; code: string | null; message: string | null };

const ok = (value: string): Check => ({ value, code: null, message: null });
const fail = (code: string, message: string): Check => ({ value: null, code, message });
export const passed = (check: Check) => check.code === null;

type Rule = (value: string) => Check;

const SAFE_CHARS = /^[A-Za-z0-9#.,%()\s'"_+-]*$/;
const LENGTH = /^(-?\d{1,4}(?:\.\d{1,3})?)(pt|mm|cm|in|px|em|%)?$/;
const NUMBER = /^-?\d{1,4}(?:\.\d{1,3})?$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/;

type Rgb = [number, number, number];

export const NAMED_COLORS: Record<string, Rgb> = {
  black: [0, 0, 0], white: [255, 255, 255],
  gray: [128, 128, 128], grey: [128, 128, 128],
  dimgray: [105, 105, 105], darkgray: [169, 169, 169],
  lightgray: [211, 211, 211], silver: [192, 192, 192],
  red: [255, 0, 0], darkred: [139, 0, 0], maroon: [128, 0, 0],
  orange: [255, 165, 0], yellow: [255, 255, 0],
  olive: [128, 128, 0], green: [0, 128, 0],
  darkgreen: [0, 100, 0], teal: [0, 128, 128],
  navy: [0, 0, 128], blue: [0, 0, 255], darkblue: [0, 0, 139],
  purple: [128, 0, 128], brown: [165, 42, 42],
  transparent: [255, 255, 255],
};

/** Properties that are refused with an explanation (rather than "unknown"). */
const BLOCKED: Record<string, string> = {
  position: "Positioning isn't supported; use margins, floats or tables.",
  transform: "Transforms aren't supported in PDF output.",
  filter: "Filters aren't supported in PDF output.",
  opacity: "Opacity isn't supported; use a lighter colour.",
  "z-index": "Layering isn't supported.",
  background: "Only background-color is allowed (no images).",
  "background-image": "Background images aren't allowed.",
  content: "Generated content isn't allowed.",
  behavior: "Not allowed.",
  "letter-spacing": "Letter spacing breaks PDF text extraction (ATS reads \"E X P E R I E N C E\").",
  "word-spacing": "Word spacing breaks PDF text extraction.",
  font: "Use font-family, font-size, font-weight and font-style separately.",
  "list-style-image": "Images aren't allowed.",
  cursor: "Not meaningful in a PDF.",
  // Kept refused (as in the original engine) so stored documents render the same everywhere
  columns: "Multi-column layout isn't supported in PDF output; use a table with one cell per column.",
  "column-count": "Multi-column layout isn't supported in PDF output; use a table with one cell per column.",
  "column-gap": "Multi-column layout isn't supported in PDF output; use a table with one cell per column.",
  "overflow-wrap": "Use \"word-wrap\": \"break-word\" (the PDF engine doesn't support overflow-wrap).",
};

export function abbreviate(value: string) {
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

const invalid = (property: string, value: string) =>
  fail("CSS_VALUE_INVALID", `${property}: "${abbreviate(value)}" isn't a valid value.`);

function keywords(...allowed: string[]): Rule {
  const set = new Set(allowed);
  return (v) => (set.has(v) ? ok(v) : fail("CSS_VALUE_INVALID", `Use one of: ${allowed.join(", ")}.`));
}

const trimNumber = (value: number) => (Number.isInteger(value) ? String(value) : String(value));

function range(minMm: number, maxMm: number, fontSize: boolean) {
  return fontSize ? " (6–40pt)" : ` (${trimNumber(minMm)} to ${trimNumber(maxMm)}mm)`;
}

/**
 * A length in the allowed range, given in mm (font-size range is in mm too: 2.1–14.2 mm ≈ 6–40 pt).
 * em is allowed for font-size (0.5–4) and treated as relative elsewhere (×4.23 mm). Null when not acceptable.
 */
function lengthOpt(v: string, minMm: number, maxMm: number, allowNegative: boolean, allowPercent: boolean,
  fontSize = false): Check | null {
  const m = LENGTH.exec(v);
  if (!m) return null;
  const number = Number(m[1]);
  const unit = m[2];
  if (number < 0 && !allowNegative) return null;
  // Unitless is only fine for zero
  if (unit === undefined) return number === 0 ? ok("0") : null;
  if (unit === "%") {
    if (fontSize) return number >= 50 && number <= 400 ? ok(v) : null;
    return allowPercent && number >= 0 && number <= 100 ? ok(v) : null;
  }
  if (unit === "em" && fontSize) return number >= 0.5 && number <= 4 ? ok(v) : null;
  const factor: Record<string, number> = { pt: 25.4 / 72, mm: 1, cm: 10, in: 25.4, px: 25.4 / 96, em: 4.23 };
  const mm = number * (factor[unit] ?? Number.NaN);
  return mm >= minMm - 0.001 && mm <= maxMm + 0.001 ? ok(v) : null;
}

function length(v: string, property: string, minMm: number, maxMm: number, allowNegative: boolean, fontSize: boolean,
  allowPercent: boolean): Check {
  return lengthOpt(v, minMm, maxMm, allowNegative, allowPercent, fontSize)
    ?? fail("CSS_VALUE_INVALID",
      `${property}: "${abbreviate(v)}" must be a length like 10pt, 4mm or 1.2em${range(minMm, maxMm, fontSize)}.`);
}

function repeat(v: string, property: string, max: number, part: (token: string) => Check | null): Check {
  const tokens = v.split(" ");
  if (tokens.length > max) return invalid(property, v);
  for (const token of tokens) {
    const check = part(token);
    if (!check || !passed(check)) return invalid(property, v);
  }
  return ok(v);
}

/** 1–max lengths (margin, padding, border-width…). */
function sides(v: string, property: string, minMm: number, maxMm: number, allowNegative: boolean, allowAuto: boolean,
  max = 4): Check {
  const result = repeat(v, property, max, (t) =>
    allowAuto && t === "auto" ? ok(t) : lengthOpt(t, minMm, maxMm, allowNegative, false));
  return passed(result)
    ? ok(v)
    : fail("CSS_VALUE_INVALID", `${property}: "${abbreviate(v)}" must be ${max > 1 ? `1–${max} lengths` : "a length"}`
      + ` like 4mm or 6pt${range(minMm, maxMm, false)}.`);
}

function integer(v: string, property: string, min: number, max: number): Check {
  if (/^\d{1,2}$/.test(v)) {
    const n = Number(v);
    if (n >= min && n <= max) return ok(v);
  }
  return fail("CSS_VALUE_INVALID", `${property} must be a whole number from ${min} to ${max}.`);
}

function lineHeight(v: string): Check {
  if (v === "normal") return ok(v);
  if (NUMBER.test(v)) {
    const n = Number(v);
    return n >= 0.8 && n <= 3 ? ok(v) : fail("CSS_VALUE_INVALID", "line-height must be 0.8–3 (e.g. 1.35).");
  }
  return lengthOpt(v, 2, 30, false, false)
    ?? fail("CSS_VALUE_INVALID", "line-height must be a number like 1.35 or a length like 13pt.");
}

function textDecoration(v: string): Check {
  const parts = new Set(["none", "underline", "line-through", "overline"]);
  return v.split(" ").every((token) => parts.has(token))
    ? ok(v)
    : fail("CSS_VALUE_INVALID", "text-decoration: use none, underline, line-through or overline.");
}

function display(v: string): Check {
  if (v.includes("flex") || v.includes("grid")) {
    return fail("CSS_LAYOUT_UNSUPPORTED",
      `display: ${v} isn't supported in PDF output; use a table or float for side-by-side layout.`);
  }
  return keywords("block", "inline", "inline-block", "table", "table-row", "table-cell", "list-item", "none")(v);
}

const BORDER_STYLES = new Set(["none", "solid", "dashed", "dotted", "double"]);

function border(v: string, property: string): Check {
  if (v === "none" || v === "0") return ok(v);
  const tokens = v.split(" ");
  if (tokens.length > 3) return invalid(property, v);
  for (const token of tokens) {
    const good = lengthOpt(token, 0, 3, false, false) !== null || BORDER_STYLES.has(token) || passed(color(token));
    if (!good) {
      return fail("CSS_VALUE_INVALID",
        `${property}: "${abbreviate(v)}" should look like "1pt solid #c1c7d0" (width up to 3mm).`);
    }
  }
  return ok(v);
}

export function color(v: string): Check {
  return parseColor(v)
    ? ok(v)
    : fail("CSS_VALUE_INVALID",
      `"${abbreviate(v)}" isn't a colour. Use #rrggbb, #rgb, rgb(r, g, b) or a basic name like black.`);
}

function fontFamily(v: string): Check {
  const resolved: string[] = [];
  for (const part of v.split(",")) {
    const name = part.trim().replace(/^['"]|['"]$/g, "");
    const family = resolveFont(name);
    if (!family) {
      return fail("CSS_FONT_UNAVAILABLE", `Font "${abbreviate(name)}" isn't available. Use one of: `
        + `${fontFamilies().join(", ")} (or serif / sans-serif).`);
    }
    if (!resolved.includes(family)) resolved.push(family);
  }
  return ok(resolved.map((family) => `"${family}"`).join(", "));
}

const RULES = new Map<string, Rule>();
{
  // Text
  RULES.set("font-family", fontFamily);
  RULES.set("font-size", (v) => length(v, "font-size", 2.1, 14.2, false, true, false));
  RULES.set("font-weight", keywords("normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600",
    "700", "800", "900"));
  RULES.set("font-style", keywords("normal", "italic", "oblique"));
  RULES.set("color", color);
  RULES.set("line-height", lineHeight);
  RULES.set("text-align", keywords("left", "right", "center", "justify", "start", "end"));
  RULES.set("text-decoration", textDecoration);
  RULES.set("text-transform", keywords("none", "uppercase", "lowercase", "capitalize"));
  RULES.set("text-indent", (v) => length(v, "text-indent", -50, 50, true, false, false));
  RULES.set("white-space", keywords("normal", "nowrap", "pre", "pre-wrap", "pre-line"));
  RULES.set("word-break", keywords("normal", "break-all", "keep-all", "break-word"));
  RULES.set("word-wrap", keywords("normal", "break-word"));
  const verticalKeywords = new Set(["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"]);
  RULES.set("vertical-align", (v) =>
    verticalKeywords.has(v) ? ok(v) : lengthOpt(v, -20, 20, true, false) ?? invalid("vertical-align", v));
  // Box
  for (const side of ["", "-top", "-right", "-bottom", "-left"]) {
    const max = side === "" ? 4 : 1;
    RULES.set(`margin${side}`, (v) => sides(v, `margin${side}`, -20, 50, true, true, max));
    RULES.set(`padding${side}`, (v) => sides(v, `padding${side}`, 0, 50, false, true, max));
  }
  for (const size of ["width", "min-width", "max-width", "height", "min-height", "max-height"]) {
    RULES.set(size, (v) =>
      v === "auto" || (v === "none" && size.startsWith("max")) ? ok(v) : length(v, size, 0, 300, false, false, true));
  }
  // Borders
  for (const side of ["", "-top", "-right", "-bottom", "-left"]) {
    const max = side === "" ? 4 : 1;
    RULES.set(`border${side}`, (v) => border(v, `border${side}`));
    RULES.set(`border${side}-width`, (v) => sides(v, `border${side}-width`, 0, 3, false, false, max));
    RULES.set(`border${side}-style`, (v) =>
      repeat(v, `border${side}-style`, max, (t) => (BORDER_STYLES.has(t) ? ok(t) : null)));
    RULES.set(`border${side}-color`, (v) =>
      repeat(v, `border${side}-color`, max, (t) => (passed(color(t)) ? ok(t) : null)));
  }
  RULES.set("border-radius", (v) => sides(v, "border-radius", 0, 20, false, false, 4));
  RULES.set("border-collapse", keywords("collapse", "separate"));
  RULES.set("border-spacing", (v) => sides(v, "border-spacing", 0, 10, false, false, 2));
  RULES.set("background-color", color);
  // Layout
  RULES.set("display", display);
  RULES.set("float", keywords("left", "right", "none"));
  RULES.set("clear", keywords("left", "right", "both", "none"));
  RULES.set("list-style-type", keywords("disc", "circle", "square", "decimal", "lower-alpha", "upper-alpha",
    "lower-roman", "upper-roman", "none"));
  RULES.set("list-style-position", keywords("inside", "outside"));
  // Pages
  RULES.set("page-break-before", keywords("auto", "always", "avoid", "left", "right"));
  RULES.set("page-break-after", keywords("auto", "always", "avoid", "left", "right"));
  RULES.set("page-break-inside", keywords("auto", "avoid"));
  RULES.set("orphans", (v) => integer(v, "orphans", 1, 10));
  RULES.set("widows", (v) => integer(v, "widows", 1, 10));
  // Minimum space left on a page before a block moves to the next one (written as break-inside hints)
  RULES.set("-fs-page-break-min-height", (v) => length(v, "-fs-page-break-min-height", 0, 150, false, false, false));
}

export const cssProperties = () => [...RULES.keys()];

/** Checks one declaration. The property name must already be lower-case. */
export function checkCss(property: string, rawValue: string | null | undefined): Check {
  const blocked = BLOCKED[property];
  if (blocked) return fail("CSS_PROPERTY_BLOCKED", `"${property}" isn't allowed: ${blocked}`);
  const rule = RULES.get(property);
  if (!rule) return fail("CSS_PROPERTY_UNKNOWN", `"${property}" isn't a supported CSS property.`);
  const value = (rawValue ?? "").trim().replace(/\s+/g, " ");
  if (!value || value.length > 200) {
    return fail("CSS_VALUE_INVALID", `${property} needs a value (at most 200 characters).`);
  }
  const lower = value.toLowerCase();
  if (lower.includes("url(") || lower.includes("expression") || lower.includes("!important")
    || lower.includes("/*") || lower.includes("\\") || !SAFE_CHARS.test(value)) {
    return fail("CSS_VALUE_BLOCKED", `${property}: "${abbreviate(value)}" isn't allowed `
      + "(no url(), !important, comments or special characters).");
  }
  return rule(property === "font-family" ? value : lower);
}

/** A contrast warning for a style that sets color: against its own background-color, or white. */
export function contrastWarning(style: Record<string, string>): string | null {
  const fgText = style.color;
  if (fgText == null) return null;
  const fg = parseColor(fgText);
  const bg = style["background-color"] != null ? parseColor(style["background-color"]) : ([255, 255, 255] as Rgb);
  if (!fg || !bg) return null;
  const ratio = contrast(fg, bg);
  return ratio < 4.5 ? `Text contrast is ${ratio.toFixed(1)}:1; 4.5:1 or more is easier to read.` : null;
}

export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (Object.hasOwn(NAMED_COLORS, v)) return NAMED_COLORS[v]!;
  const hex = HEX.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h[0]! + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = RGB.exec(v);
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return r <= 255 && g <= 255 && b <= 255 ? [r, g, b] : null;
  }
  return null;
}

function contrast(a: Rgb, b: Rgb) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(c: Rgb) {
  const v = c.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}
