import { randomUUID } from "node:crypto";

/*
 * Builds the RFC 5322 message Gmail sends: a plain-text part and an HTML part, both base64 encoded.
 * - Header values must be single-line (no CR/LF), which prevents header injection.
 * - The HTML part is the plain text, HTML-escaped, so merge-field values can't inject markup.
 * - A non-ASCII subject is RFC 2047 encoded.
 * From is left out on purpose: Gmail sets it to the authenticated account.
 */

const CRLF = "\r\n";

export function buildMimeMessage(to: string, subject: string, textBody: string): string {
  requireSingleLine("recipient", to);
  requireSingleLine("subject", subject);
  const boundary = `careerpilot_${randomUUID().replaceAll("-", "")}`;
  const text = normaliseLineBreaks(textBody);
  return (
    `To: ${to}${CRLF}` +
    `Subject: ${encodeHeader(subject)}${CRLF}` +
    `MIME-Version: 1.0${CRLF}` +
    `Content-Type: multipart/alternative; boundary="${boundary}"${CRLF}` +
    CRLF +
    part(boundary, "text/plain", text) +
    part(boundary, "text/html", toHtml(text)) +
    `--${boundary}--${CRLF}`
  );
}

/** Escapes the five HTML-significant characters. Values are never interpreted as markup. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** RFC 2047 "B" encoding in chunks short enough for an encoded-word (≤ 75 chars). */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(encodedWord(chunk));
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(encodedWord(chunk));
  return words.join(`${CRLF} `);
}

const encodedWord = (text: string) => `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;

function toHtml(text: string) {
  const escaped = escapeHtml(text).replaceAll(CRLF, `<br>${CRLF}`);
  return '<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
    + `line-height:1.5">${escaped}</div></body></html>`;
}

function part(boundary: string, contentType: string, content: string) {
  const base64 = Buffer.from(content, "utf8").toString("base64");
  const lines = base64.match(/.{1,76}/g) ?? [];
  return `--${boundary}${CRLF}`
    + `Content-Type: ${contentType}; charset=UTF-8${CRLF}`
    + `Content-Transfer-Encoding: base64${CRLF}`
    + CRLF
    + lines.join(CRLF)
    + CRLF;
}

const normaliseLineBreaks = (text: string) => text.replace(/\r\n|\r/g, "\n").replace(/\n/g, CRLF);

function requireSingleLine(field: string, value: string) {
  if (!value || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a non-empty single line`);
  }
}
