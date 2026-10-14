import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { DocEngine } from "../../src/docengine/engine.js";
import { ReactPdfRenderer } from "../../src/docengine/pdf.js";
import { DocPresets } from "../../src/docengine/presets.js";
import { resumeToDoc } from "../../src/resumes/resume-to-doc.js";
import { validResume } from "../helpers.js";

/* Real PDFs with @react-pdf/renderer (pure JavaScript, no browser). */

describe("PDF rendering", () => {
  const renderer = new ReactPdfRenderer({
    maxPages: 10, maxBytes: 5 * 1024 * 1024, renderTimeoutMs: 60_000, maxConcurrent: 2, maxQueued: 8,
  });
  const engine = new DocEngine(new DocPresets(), renderer);

  it("prints a resume in both templates to a one-page A4 PDF", async () => {
    for (const template of ["classic", "modern"]) {
      const doc = engine.require(resumeToDoc(template, "A4", validResume()), "STRICT");
      const pdf = await engine.toPdf(doc);
      expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.pages).toBe(1);
      const loaded = await PDFDocument.load(pdf.bytes);
      const { width, height } = loaded.getPage(0).getSize();
      expect(Math.round(width)).toBe(595);
      expect(Math.round(height)).toBe(842);
      expect(loaded.getTitle()).toBe("Priya Sharma — Resume");
    }
  });

  it("prints Letter pages", async () => {
    const doc = engine.require(resumeToDoc("classic", "LETTER", validResume()), "STRICT");
    const loaded = await PDFDocument.load((await engine.toPdf(doc)).bytes);
    expect(Math.round(loaded.getPage(0).getSize().width)).toBe(612);
  });

  it("handles tables, lists, floats and page breaks", async () => {
    const doc = engine.require({
      schemaVersion: 3, document: "resume",
      sections: [
        { id: "a", nodes: [
          { tag: "table", children: [{ tag: "tr", children: [
            { tag: "td", style: { width: "60%" }, text: "Left" },
            { tag: "td", style: { "white-space": "nowrap" }, text: "Right" },
          ] }] },
          { tag: "ol", attrs: { type: "i", start: 3 }, children: [{ tag: "li", text: "Three" }, { tag: "li", html: "<b>Four</b>" }] },
          { tag: "p", children: [{ tag: "span", text: "Title" }, { tag: "span", style: { float: "right" }, text: "2025" }] },
          { tag: "pre", text: "  keeps\n  spacing" },
        ] },
        { id: "b", style: { "page-break-before": "always" }, nodes: [{ tag: "h2", text: "Second page" }] },
      ],
    }, "STRICT");
    expect((await engine.toPdf(doc)).pages).toBe(2);
  });

  it("refuses documents that are too long", async () => {
    const sections = Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`, style: { "page-break-before": i === 0 ? "auto" : "always" }, nodes: [{ tag: "p", text: `Page ${i + 1}` }],
    }));
    const doc = engine.require({ schemaVersion: 3, document: "resume", page: { maxPages: 2 }, sections }, "STRICT");
    await expect(engine.toPdf(doc)).rejects.toMatchObject({ code: "DOCUMENT_TOO_LONG", status: 422 });
  });
});
