import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { DocEngine } from "../../src/docengine/engine.js";
import { ChromiumPdfRenderer } from "../../src/docengine/pdf.js";
import { DocPresets } from "../../src/docengine/presets.js";
import { resumeToDoc } from "../../src/resumes/resume-to-doc.js";
import { validResume } from "../helpers.js";

/* Real PDFs with headless Chromium and pdf.js. Slow, so only with RUN_PDF_TESTS=true. */

describe.skipIf(process.env.RUN_PDF_TESTS !== "true")("PDF rendering with Chromium", () => {
  const renderer = new ChromiumPdfRenderer({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? null,
    maxPages: 10, maxBytes: 5 * 1024 * 1024, renderTimeoutMs: 60_000, maxConcurrent: 2, maxQueued: 8,
  });
  const engine = new DocEngine(new DocPresets(), renderer);

  afterAll(async () => {
    await renderer.close();
  });

  it("prints a resume to a one-page PDF and draws page images", async () => {
    const doc = engine.require(resumeToDoc("classic", "A4", validResume()), "STRICT");
    const pdf = await engine.toPdf(doc);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.pages).toBe(1);
    const loaded = await PDFDocument.load(pdf.bytes);
    const { width, height } = loaded.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);

    const images = await renderer.pageImages(pdf.bytes);
    expect(images).toHaveLength(1);
    expect(images[0]!.subarray(1, 4).toString()).toBe("PNG");
  });

  it("never loads anything from the network", async () => {
    const xhtml = '<!DOCTYPE html><html><head><style>\nbody { background: url("https://example.com/x.png"); }</style></head>'
      + '<body><img src="https://example.com/y.png" /><p>Offline</p></body></html>';
    const pdf = await renderer.convert(xhtml);
    expect(pdf.pages).toBe(1);
  });

  it("refuses documents that are too long", async () => {
    const sections = Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`, style: { "page-break-before": i === 0 ? "auto" : "always" }, nodes: [{ tag: "p", text: `Page ${i + 1}` }],
    }));
    const doc = engine.require({ schemaVersion: 3, document: "resume", page: { maxPages: 2 }, sections }, "STRICT");
    await expect(engine.toPdf(doc)).rejects.toMatchObject({ code: "DOCUMENT_TOO_LONG", status: 422 });
  });
});
