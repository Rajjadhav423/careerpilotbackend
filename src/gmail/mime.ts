import { randomUUID } from "node:crypto";

/*
 * Builds the RFC 5322 message Gmail sends: a plain-text part and an HTML part, both base64 encoded.
 * - Header values must be single-line (no CR/LF), which prevents header injection.
 * - The HTML part is the plain text, HTML-escaped, so merge-field values can't inject markup.
 * - A non-ASCII subject is RFC 2047 encoded.
 * From is left out on purpose: Gmail sets it to the authenticated account.
 */

const CRLF = "\r\n";

/** A PDF attached to the email, e.g. a resume rendered by CareerPilot. */
export type MimeAttachment = { fileName: string; content: Uint8Array };

/**
 * Options:
 * - trackingPixelUrl: an https URL of a 1x1 image added to the end of the HTML part only (open tracking).
 * - inReplyTo: the Message-ID ("<...>") of the email this one follows up, so mail apps show them as one conversation.
 */
export type MimeOptions = { trackingPixelUrl?: string; inReplyTo?: string | null };

/** An RFC 5322 Message-ID such as <abc@mail.gmail.com>: no spaces, line breaks or extra angle brackets. */
const MESSAGE_ID = /^<[^<>\s]{1,995}>$/;

export function buildMimeMessage(
  to: string, subject: string, textBody: string, attachment?: MimeAttachment, options: MimeOptions = {},
): string {
  const { trackingPixelUrl, inReplyTo } = options;
  requireSingleLine("recipient", to);
  requireSingleLine("subject", subject);
  if (inReplyTo && !MESSAGE_ID.test(inReplyTo)) throw new Error("inReplyTo must be a single Message-ID");
  const boundary = `careerpilot_${randomUUID().replaceAll("-", "")}`;
  const text = normaliseLineBreaks(textBody);
  const alternative = part(boundary, "text/plain", text) + part(boundary, "text/html", toHtml(text, trackingPixelUrl)) + `--${boundary}--${CRLF}`;
  const threading = inReplyTo ? `In-Reply-To: ${inReplyTo}${CRLF}References: ${inReplyTo}${CRLF}` : "";
  const headers = `To: ${to}${CRLF}Subject: ${encodeHeader(subject)}${CRLF}${threading}MIME-Version: 1.0${CRLF}`;
  if (!attachment) return `${headers}Content-Type: multipart/alternative; boundary="${boundary}"${CRLF}${CRLF}${alternative}`;

  // multipart/mixed: the text and HTML versions, then the PDF
  const mixed = `careerpilot_${randomUUID().replaceAll("-", "")}`;
  return (
    `${headers}Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}` +
    `--${mixed}${CRLF}Content-Type: multipart/alternative; boundary="${boundary}"${CRLF}${CRLF}${alternative}` +
    pdfPart(mixed, attachment) +
    `--${mixed}--${CRLF}`
  );
}

function pdfPart(boundary: string, attachment: MimeAttachment) {
  // Quotes, backslashes and line breaks can't end the header early; non-ASCII names are RFC 2047 encoded
  const name = attachment.fileName.replace(/["\\\r\n]/g, " ").trim() || "Resume.pdf";
  const quoted = encodeHeader(name);
  const lines = Buffer.from(attachment.content).toString("base64").match(/.{1,76}/g) ?? [];
  return `--${boundary}${CRLF}`
    + `Content-Type: application/pdf; name="${quoted}"${CRLF}`
    + `Content-Disposition: attachment; filename="${quoted}"${CRLF}`
    + `Content-Transfer-Encoding: base64${CRLF}`
    + CRLF
    + lines.join(CRLF)
    + CRLF;
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

function toHtml(text: string, trackingPixelUrl?: string) {
  const escaped = escapeHtml(text).replaceAll(CRLF, `<br>${CRLF}`);
  const pixel = trackingPixelUrl
    ? `<img src="${escapeHtml(trackingPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`
    : "";
  return '<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
    + `line-height:1.5">${escaped}</div>${pixel}</body></html>`;
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
