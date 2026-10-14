import { readFileSync } from "node:fs";
import path from "node:path";

import { ApiError } from "../http/errors.js";
import { writeDocJson, type JsonObject } from "./doc-json.js";
import { RESOURCES_DIR } from "./fonts.js";
import type { Doc } from "./model.js";
import type { PdfRenderer, RenderedPdf } from "./pdf.js";
import type { DocPresets, Preset } from "./presets.js";
import { readDoc, type Issue, type ReadMode, type ReadResult } from "./reader.js";
import { toXhtml } from "./writer.js";

/*
 * docEngine: document JSON → validated Doc → XHTML → PDF (and page images for previews). The rules are in
 * docengine/spec/doc-rules.md, served at GET /api/v1/docs/rules so people and AI assistants can write valid documents.
 */

export class DocEngine {
  readonly rules: string;

  constructor(
    private readonly presetStore: DocPresets,
    private readonly pdf: PdfRenderer,
    rulesFile = path.join(RESOURCES_DIR, "spec", "doc-rules.md"),
  ) {
    this.rules = readFileSync(rulesFile, "utf8");
  }

  /**
   * Renders one small document in the background after startup, so fonts are loaded before the first real request.
   */
  warmUp() {
    const start = Date.now();
    const doc = this.require({
      schemaVersion: 3, document: "resume", preset: "classic",
      sections: [{ id: "s", nodes: [{ tag: "h1", text: "Warm-up" }, { tag: "p", html: "<b>Bold</b> <i>italic</i> text" }] }],
    }, "STRICT");
    this.toPdf(doc)
      .then(() => console.info(`docEngine ready in ${Date.now() - start} ms`))
      .catch((error: Error) => console.warn(`docEngine warm-up failed: ${error.message}`));
  }

  /** Validates without throwing. */
  read(json: unknown, mode: ReadMode): ReadResult {
    return readDoc(json, mode, this.presetStore.stylesById());
  }

  /** A valid document, or 400 DOCUMENT_INVALID with every issue (path, code, message). */
  require(json: unknown, mode: ReadMode): Doc {
    const result = this.read(json, mode);
    if (!result.doc) throw invalidDocument(result.errors);
    return result.doc;
  }

  toXhtml(doc: Doc): string {
    return toXhtml(doc, this.presetStore.find(doc.preset)?.styles ?? {});
  }

  /** Throws 422 DOCUMENT_TOO_LONG when the PDF has more pages than page.maxPages. */
  async toPdf(doc: Doc): Promise<RenderedPdf> {
    const rendered = await this.pdf.render(doc, this.presetStore.find(doc.preset)?.styles ?? {});
    const max = doc.page.maxPages;
    if (rendered.pages > max) {
      throw new ApiError(422, "DOCUMENT_TOO_LONG", `The document is ${rendered.pages} pages but maxPages is ${max}. `
        + "Shorten some sections or reduce font sizes and spacing.", { pages: rendered.pages, maxPages: max });
    }
    return rendered;
  }

  toJson(doc: Doc): JsonObject {
    return writeDocJson(doc);
  }

  presets(): Preset[] {
    return this.presetStore.all();
  }
}

export function invalidDocument(errors: Issue[]) {
  return new ApiError(400, "DOCUMENT_INVALID",
    errors.length === 1 ? errors[0]!.message : `The document breaks ${errors.length} rules.`, { issues: errors });
}

/** A safe download name: from the request, else the document title, else "Resume" / "Cover letter". */
export function pdfFileName(preferred: string | null | undefined, doc: Doc): string {
  const base = preferred?.trim() ? preferred
    : doc.meta.title ?? (doc.document === "coverLetter" ? "Cover letter" : "Resume");
  let cleaned = base.replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120).trim();
  return `${!cleaned || /^\.+$/.test(cleaned) ? "Document" : cleaned}.pdf`;
}

/** Content-Disposition for a download: ASCII fallback plus the UTF-8 name (RFC 6266 / 5987). */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
