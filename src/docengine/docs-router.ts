import { Router, type Request } from "express";

import { currentUser } from "../auth/clerk.js";
import { ApiError } from "../http/errors.js";
import { fillFields, type UserFieldService } from "../users/fields.js";
import { attachment, pdfFileName, type DocEngine } from "./engine.js";
import type { ReadMode } from "./reader.js";

/*
 * docEngine API: the rules, presets, validation and rendering of document JSON (doc-rules.md). Every request body is
 * { "document": {…}, "mode": "strict" | "lenient", "fileName"?: "…" }.
 */

/** The HTML is our own escaped markup, but it's shown in a browser: forbid scripts and remote loads. */
export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors *";

type Body = Record<string, unknown>;

function requestBody(req: Request): Body {
  const body = req.body as unknown;
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

export function documentOf(body: Body): unknown {
  const document = body.document;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ApiError(400, "DOCUMENT_MISSING", "Send { \"document\": { … } } (see GET /api/v1/docs/rules).");
  }
  return document;
}

export function modeOf(body: Body): ReadMode {
  const raw = body.mode;
  const mode = typeof raw === "string" ? raw.toLowerCase() : raw == null ? "strict" : "invalid";
  if (mode === "strict" || mode === "") return "STRICT";
  if (mode === "lenient") return "LENIENT";
  throw new ApiError(400, "MODE_INVALID", "mode must be \"strict\" or \"lenient\".");
}

export function docsRouter(engine: DocEngine, fields: UserFieldService): Router {
  const router = Router();
  /** The document with the user's saved details ({{github}} …) filled in, for printing. */
  const printable = async (res: Parameters<typeof currentUser>[0], document: unknown) =>
    fillFields(fields, currentUser(res).id, document);

  router.get("/rules", (_req, res) => {
    res.type("text/markdown; charset=utf-8").send(engine.rules);
  });

  router.get("/presets", (_req, res) => {
    res.json(engine.presets());
  });

  /** Checks a document. Valid documents are also rendered once to report their page count; lenient mode returns
   * the repaired document. */
  router.post("/validate", async (req, res) => {
    const body = requestBody(req);
    const mode = modeOf(body);
    const result = engine.read(documentOf(body), mode);
    const response: Record<string, unknown> = { valid: result.doc !== null, errors: result.errors, warnings: result.warnings };
    let pages: number | null = null;
    if (result.doc) {
      try {
        // Counted on the printed version: saved details ({{github}} …) filled in
        const printed = engine.read(await printable(res, documentOf(body)), mode).doc ?? result.doc;
        pages = (await engine.toPdf(printed)).pages;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Too long or too large: report it like a rule error
        response.valid = false;
        response.errors = [{ path: "/page/maxPages", code: error.code, message: error.message }];
      }
      if (mode === "LENIENT") response.document = engine.toJson(result.doc);
    }
    response.pages = pages;
    res.json(response);
  });

  router.post("/render/pdf", async (req, res) => {
    const body = requestBody(req);
    const doc = engine.require(await printable(res, documentOf(body)), modeOf(body));
    const pdf = await engine.toPdf(doc);
    const fileName = typeof body.fileName === "string" ? body.fileName : null;
    res.status(200)
      .type("application/pdf")
      .set("Content-Disposition", attachment(pdfFileName(fileName, doc)))
      .set("Cache-Control", "no-store")
      .set("X-Document-Pages", String(pdf.pages))
      .send(pdf.bytes);
  });

  /** The PDF as base64 with its page count, for the editor's page preview (drawn in the browser with pdf.js). */
  router.post("/render/pages", async (req, res) => {
    const body = requestBody(req);
    const pdf = await engine.toPdf(engine.require(await printable(res, documentOf(body)), modeOf(body)));
    res.set("Cache-Control", "no-store").json({ pageCount: pdf.pages, pdf: pdf.bytes.toString("base64") });
  });

  router.post("/render/html", async (req, res) => {
    const body = requestBody(req);
    const doc = engine.require(await printable(res, documentOf(body)), modeOf(body));
    res.type("text/html; charset=utf-8")
      .set("Content-Security-Policy", HTML_CSP)
      .set("Cache-Control", "no-store")
      .send(engine.toXhtml(doc));
  });

  return router;
}
