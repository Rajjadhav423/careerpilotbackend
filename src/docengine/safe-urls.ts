/*
 * Decides which user-supplied links may appear in a generated document.
 *
 * Links are only written into the PDF as clickable annotations; the server never fetches them (the renderer blocks
 * all network requests), so they can't be used for server-side requests. This check stops dangerous schemes
 * (javascript:, data:, file:, …) and look-alike tricks (credentials in the URL) from reaching a reader's PDF viewer.
 */

export const MAX_URL_LENGTH = 500;

const WEB_SCHEMES = new Set(["http:", "https:"]);

/**
 * The normalized link, or null if it isn't an absolute http(s) URL we're willing to print.
 * A missing scheme is treated as https ("github.com/raj" → "https://github.com/raj").
 */
export function webLink(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH || /[\s\x00-\x1F\x7F-\x9F]/.test(trimmed)) return null;
  const candidate = trimmed.includes("://") || looksLikeScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!WEB_SCHEMES.has(url.protocol) || url.username || url.password) return null;
  // "https://user@host" leaves an empty username in some parsers; reject any "@" before the host as well
  const authority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#]/)[0] ?? "";
  if (authority.includes("@")) return null;
  const host = url.hostname;
  if (!host || (!host.includes(".") && host !== "localhost")) return null;
  return url.href === `${url.origin}/` && !/\/$/.test(candidate) ? url.origin : url.href;
}

const MAILTO = /^mailto:([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})(\?[A-Za-z0-9=&%._+-]{0,200})?$/i;

/** A phone number: digits with an optional leading +, and spaces, dashes, dots or brackets between. */
const TEL = /^tel:(\+?[0-9(][0-9 ().-]{2,28}[0-9])$/i;

/**
 * A link for a document: a web link (see webLink), a mailto: address with an optional simple query (subject=…) or
 * a tel: phone number (spaces removed). Anything else (javascript:, data:, file:, …) is null.
 */
export function documentLink(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.slice(0, 7).toLowerCase() === "mailto:") {
    return trimmed.length <= MAX_URL_LENGTH && MAILTO.test(trimmed) ? `mailto:${trimmed.slice(7)}` : null;
  }
  if (trimmed.slice(0, 4).toLowerCase() === "tel:") {
    const match = TEL.exec(trimmed);
    return match ? `tel:${match[1]!.replace(/[ ().-]/g, "")}` : null;
  }
  return webLink(trimmed);
}

/** True for a value we can turn into a safe link. Blank counts as valid (optional). */
export const isAcceptableWebLink = (value: string | null | undefined) =>
  value == null || value.trim() === "" || webLink(value) !== null;

function looksLikeScheme(value: string) {
  // "javascript:alert(1)", "mailto:x", "data:…": keep the scheme so the check rejects it; "host:8080/x" is a port
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  return /^[\p{L}\p{N}+.-]+$/u.test(value.slice(0, colon)) && !/^\d+(\/.*)?$/s.test(value.slice(colon + 1));
}
