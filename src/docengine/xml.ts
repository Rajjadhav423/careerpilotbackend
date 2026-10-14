/* Escaping for the XHTML the engine writes. Characters that aren't allowed in XML are removed. */

// Control characters (except tab, newline, carriage return) and lone surrogates aren't valid in XML/PDF text
const INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const clean = (value: string | null | undefined) => (value == null ? "" : value.replace(INVALID, ""));

export const escapeText = (value: string | null | undefined) =>
  clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const escapeAttribute = (value: string | null | undefined) =>
  escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\n", "&#10;");
