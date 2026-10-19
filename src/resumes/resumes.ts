import { readFileSync } from "node:fs";
import path from "node:path";

import type { Resume as ResumeModel, ResumeVersion as VersionModel } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import { asJson, jsonOrNull, type Db, type Tx } from "../db/prisma.js";
import type { DocEngine } from "../docengine/engine.js";
import { attachment, invalidDocument } from "../docengine/engine.js";
import { RESOURCES_DIR } from "../docengine/fonts.js";
import type { PageSize } from "../docengine/model.js";
import type { RenderedPdf } from "../docengine/pdf.js";
import type { Preset } from "../docengine/presets.js";
import type { DriveService } from "../drive/drive.js";
import { fillFields, type UserFieldService } from "../users/fields.js";
import { ApiError, fieldErrors, validationError } from "../http/errors.js";
import { body, uuidParam } from "../http/validate.js";
import { docDiff, resumeDiff, type Change } from "./diff.js";
import { docToResume } from "./doc-to-resume.js";
import { normalize, readResumeJson, resumeDataSchema, type ResumeData } from "./resume-data.js";
import { resumeToDoc } from "./resume-to-doc.js";

/*
 * Saved resumes, plus rendering (HTML preview, PDF download, save to Google Drive). Rendering endpoints take the
 * resume data in the request, so unsaved edits can be previewed. Other users' resumes are never visible (404).
 *
 * Versions (RESUME_VERSIONS_ENABLED): each save records a SAVED version (history, the newest MAX_SAVED_VERSIONS are
 * kept). Proposals (imported JSON, AI suggestions) don't touch the resume until the owner accepts them; restoring an
 * old version records a new SAVED version, so nothing is ever lost by accepting or restoring.
 */

export const MAX_RESUMES_PER_USER = 50;
export const MAX_SAVED_VERSIONS = 30;
export const MAX_OPEN_PROPOSALS = 20;
export const DEFAULT_TEMPLATE = "classic";

export const VERSION_SOURCES = ["EDITOR", "IMPORT", "AI", "RESTORE"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];
export type VersionStatus = "SAVED" | "PROPOSED" | "ACCEPTED";

/** The preview is our own escaped markup, but it's shown in the browser: forbid scripts and remote loads. */
const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors *";

// ---- request bodies ----

const pageSize = z.enum(["A4", "LETTER"], { message: "must be A4 or LETTER" }).nullish();
const templateId = z.string().max(40, "size must be between 0 and 40").nullish();
const data = resumeDataSchema.nullish().refine((value) => value != null, "is required");
const documentJson = z.unknown().optional();
/**
 * The resume's document when the request carries edited form data: the form is converted and merged into it, so the
 * document's styles, page settings and section styles survive form edits.
 */
const baseDocument = z.unknown().optional();
const uuid = z.string({ required_error: "is required" }).uuid("must be a valid id");

/** Create or replace a saved resume. `document` (optional) is a docEngine document that, when present, is rendered. */
export const resumeRequestSchema = z.object({
  title: z.string({ required_error: "is required", invalid_type_error: "is required" })
    .max(120, "size must be between 0 and 120").refine((v) => v.trim() !== "", "is required"),
  templateId,
  pageSize,
  data: z.unknown().optional(),
  document: documentJson,
  baseDocument,
}).superRefine((value, ctx) => {
  if (hasDocument(value)) return;
  const parsed = data.safeParse(value.data);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
}).transform((value) => ({ ...value, data: formData(value) }));

const hasDocument = (value: { document?: unknown }) => value.document !== undefined && value.document !== null;

/**
 * With a document, the document is what's printed and the form is only a copy that may be stale or incomplete: it's
 * cleaned up instead of rejected. Without one, the form must be valid.
 */
function formData(value: { data?: unknown; document?: unknown }): ResumeData {
  if (!hasDocument(value)) return data.parse(value.data) as ResumeData;
  const parsed = resumeDataSchema.safeParse(value.data);
  return parsed.success ? parsed.data as ResumeData : normalize(value.data);
}

/** Render resume data that may not be saved yet (preview, download, save to Drive). */
export const renderRequestSchema = z.object({
  templateId,
  pageSize,
  data,
  baseDocument,
  fileName: z.string().max(150, "size must be between 0 and 150").nullish(),
});

/** Suggested changes to a saved resume, stored as a proposal until the owner accepts it. */
export const proposalRequestSchema = z.object({
  label: z.string().max(120, "size must be between 0 and 120").nullish(),
  source: z.enum(VERSION_SOURCES, { message: `must be one of ${VERSION_SOURCES.join(", ")}` }).nullish(),
  templateId,
  pageSize,
  data: resumeDataSchema.nullish(),
  document: documentJson,
});

export const saveToDriveSchema = z.object({
  requestId: uuid,
  templateId,
  pageSize,
  // Not checked when a document is sent: the document is what gets printed, and the form may be stale or empty
  data: z.unknown().optional(),
  document: documentJson,
  baseDocument,
  fileName: z.string().max(150, "size must be between 0 and 150").nullish(),
  folderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "is not a folder id").nullish(),
  resumeId: z.string().uuid("must be a valid id").nullish(),
}).superRefine((value, ctx) => {
  if (hasDocument(value)) return;
  const parsed = data.safeParse(value.data);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
}).transform((value) => ({ ...value, data: formData(value) }));

export type ResumeRequest = z.infer<typeof resumeRequestSchema>;
export type ProposalRequest = z.infer<typeof proposalRequestSchema>;

// ---- rows and responses ----

type ResumeRow = ResumeModel;
type VersionRow = VersionModel;
type JsonDoc = Record<string, unknown>;

export type ResumeResponse = {
  id: string;
  title: string;
  templateId: string;
  pageSize: PageSize;
  data: ResumeData;
  document: Record<string, unknown> | null;
  /** The assistant's tailored copy, not a resume the user wrote */
  aiCopy: boolean;
  createdAt: Date;
  updatedAt: Date;
};


/** A safe download name, also the default Drive file name: "<Name> - Resume.pdf" when none is given. */
export function resumeFileName(preferred: string | null | undefined, data: unknown): string {
  let base = preferred;
  if (!base?.trim()) {
    const name = normalize(data).basics.fullName;
    base = name ? `${name.trim()} - Resume` : "Resume";
  }
  let cleaned = base.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 120).trim();
  return `${!cleaned || /^\.+$/.test(cleaned) ? "Resume" : cleaned}.pdf`;
}

/**
 * Resume data (the editor's format) → docEngine document → XHTML / PDF / page images, through exactly the same
 * validation and rendering as any document sent to /api/v1/docs. Templates are docEngine presets.
 */
export class ResumeDocuments {
  constructor(private readonly engine: DocEngine) {}

  templates(): Preset[] {
    return this.engine.presets();
  }

  template(id: string | null | undefined): Preset {
    const preset = this.engine.presets().find((p) => p.id === (id ?? DEFAULT_TEMPLATE));
    if (!preset) throw new ApiError(400, "UNKNOWN_TEMPLATE", "That resume template doesn't exist.");
    return preset;
  }

  /**
   * The resume as document JSON (schema version 3). With a base document, the form's content is merged into it: the
   * base keeps its styles, page settings (except paper size and form margins) and the style of each section.
   */
  toDocument(templateId: string | null | undefined, size: PageSize | null | undefined, data: unknown, base?: unknown): JsonDoc {
    const generated = resumeToDoc(this.template(templateId).id, size ?? null, data);
    if (base === undefined || base === null) return generated;
    const read = this.engine.read(base, "LENIENT").doc;
    return read ? mergeDocument(generated, this.engine.toJson(read)) : generated;
  }

  /** A document read back into the form's format, with its preset and paper size. */
  toForm(document: unknown) {
    const result = this.engine.read(document, "LENIENT");
    if (!result.doc) throw invalidDocument(result.errors);
    const preset = result.doc.preset && this.engine.presets().some((p) => p.id === result.doc!.preset)
      ? result.doc.preset : DEFAULT_TEMPLATE;
    return { templateId: preset, pageSize: result.doc.page.size, data: docToResume(result.doc) };
  }

  renderHtml(templateId: string | null | undefined, size: PageSize | null | undefined, data: unknown, base?: unknown): string {
    return this.engine.toXhtml(this.doc(templateId, size, data, base));
  }

  renderPdf(templateId: string | null | undefined, size: PageSize | null | undefined, data: unknown, base?: unknown): Promise<RenderedPdf> {
    return this.engine.toPdf(this.doc(templateId, size, data, base));
  }


  /** A docEngine document checked with the strict rules and written back normalized (what gets stored). */
  normalizeDocument(document: unknown): Record<string, unknown> {
    return this.engine.toJson(this.engine.require(document, "STRICT"));
  }

  renderDocumentPdf(document: unknown): Promise<RenderedPdf> {
    return this.engine.toPdf(this.engine.require(document, "STRICT"));
  }

  private doc(templateId: string | null | undefined, size: PageSize | null | undefined, data: unknown, base?: unknown) {
    return this.engine.require(this.toDocument(templateId, size, data, base), "STRICT");
  }
}

/** The form's document with the base document's styling kept (see ResumeDocuments.toDocument). */
export function mergeDocument(generated: JsonDoc, base: JsonDoc): JsonDoc {
  const page = generated.page as JsonDoc;
  const basePage = (base.page ?? {}) as JsonDoc;
  const baseSections = new Map(((base.sections ?? []) as JsonDoc[]).map((section) => [section.id, section]));
  return {
    ...generated,
    ...(base.styles ? { styles: base.styles } : {}),
    meta: { ...(generated.meta as JsonDoc), language: (base.meta as JsonDoc | undefined)?.language ?? "en" },
    page: { ...basePage, size: page.size, ...(page.margin ? { margin: page.margin } : {}) },
    sections: (generated.sections as JsonDoc[]).map((section) => {
      const style = baseSections.get(section.id)?.style;
      return style ? { ...section, style } : section;
    }),
  };
}

const resumeNotFound = () => new ApiError(404, "RESUME_NOT_FOUND", "Resume not found.");
const versionNotFound = () => new ApiError(404, "VERSION_NOT_FOUND", "Version not found.");

export class ResumeService {
  constructor(
    private readonly db: Db,
    private readonly documents: ResumeDocuments,
    private readonly versionsEnabled: boolean,
  ) {}

  async list(userId: string) {
    const resumes = await this.db.resume.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
    const pending = new Map<string, number>();
    if (this.versionsEnabled) {
      const proposals = await this.db.resumeVersion.findMany({ where: { userId, status: "PROPOSED" }, select: { resumeId: true } });
      for (const p of proposals) pending.set(p.resumeId, (pending.get(p.resumeId) ?? 0) + 1);
    }
    return resumes.map((row) => ({
      id: row.id,
      title: row.title,
      templateId: row.templateId,
      pageSize: row.pageSize as PageSize,
      fullName: normalize(readResumeJson(row.data)).basics.fullName,
      aiCopy: row.aiCopy,
      pendingProposals: pending.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async get(userId: string, id: string): Promise<ResumeResponse> {
    return response(await this.find(this.db, userId, id));
  }

  async create(userId: string, request: ResumeRequest): Promise<ResumeResponse> {
    const template = this.documents.template(request.templateId).id;
    const document = this.document(this.requestDocument(request));
    return this.db.$transaction(async (tx) => {
      if (await tx.resume.count({ where: { userId } }) >= MAX_RESUMES_PER_USER) {
        throw new ApiError(409, "RESUME_LIMIT_REACHED",
          `You can keep up to ${MAX_RESUMES_PER_USER} resumes. Delete one you no longer need.`);
      }
      const resume = await tx.resume.create({ data: {
        userId, title: request.title.trim(), templateId: template, pageSize: request.pageSize ?? "A4",
        data: asJson(normalize(request.data)), document: jsonOrNull(document),
      } });
      await this.recordVersion(tx, resume, "Created", "EDITOR", "SAVED");
      return response(resume);
    });
  }

  async update(userId: string, id: string, request: ResumeRequest): Promise<ResumeResponse> {
    const template = this.documents.template(request.templateId).id;
    const document = this.document(this.requestDocument(request));
    return this.db.$transaction(async (tx) => {
      await this.find(tx, userId, id);
      const resume = await tx.resume.update({ where: { id }, data: {
        title: request.title.trim(), templateId: template, pageSize: request.pageSize ?? "A4",
        data: asJson(normalize(request.data)), document: jsonOrNull(document),
      } });
      await this.recordVersion(tx, resume, null, "EDITOR", "SAVED");
      return response(resume);
    });
  }

  /**
   * Creates or replaces the user's single AI copy: the resume an assistant tailors for each application, so the
   * resumes the user writes never change. `created` tells whether it was made now.
   */
  async saveAiCopy(userId: string, request: ResumeRequest): Promise<ResumeResponse & { created: boolean }> {
    const template = this.documents.template(request.templateId).id;
    const document = this.document(this.requestDocument(request));
    const content = {
      title: request.title.trim(), templateId: template, pageSize: request.pageSize ?? "A4",
      data: asJson(normalize(request.data)), document: jsonOrNull(document),
    };
    return this.db.$transaction(async (tx) => {
      const existing = await tx.resume.findFirst({ where: { userId, aiCopy: true }, select: { id: true } });
      if (!existing && await tx.resume.count({ where: { userId } }) >= MAX_RESUMES_PER_USER) {
        throw new ApiError(409, "RESUME_LIMIT_REACHED",
          `You can keep up to ${MAX_RESUMES_PER_USER} resumes. Delete one you no longer need.`);
      }
      const resume = existing
        ? await tx.resume.update({ where: { id: existing.id }, data: content })
        : await tx.resume.create({ data: { userId, aiCopy: true, ...content } });
      await this.recordVersion(tx, resume, existing ? "Tailored by AI" : "Created by AI", "AI", "SAVED");
      return { ...response(resume), created: !existing };
    });
  }

  async delete(userId: string, id: string) {
    const { count } = await this.db.resume.deleteMany({ where: { id, userId } });
    if (!count) throw resumeNotFound();
  }

  /** True when the resume exists and belongs to the user (used to link Drive uploads to a resume). */
  async isOwnedBy(userId: string, id: string): Promise<boolean> {
    return (await this.db.resume.count({ where: { id, userId } })) > 0;
  }

  // ---- versions ----

  async versions(userId: string, resumeId: string) {
    const resume = await this.find(this.db, userId, resumeId);
    if (!this.versionsEnabled) return [];
    const versions = await this.db.resumeVersion.findMany({ where: { resumeId: resume.id, userId }, orderBy: { number: "desc" } });
    return versions.map((v) => ({
      id: v.id,
      number: v.number,
      label: v.label,
      source: v.source as VersionSource,
      status: v.status as VersionStatus,
      changes: v.status === "PROPOSED" ? this.changes(resume, v).length : null,
      createdAt: v.createdAt,
    }));
  }

  async version(userId: string, resumeId: string, versionId: string) {
    this.requireVersions();
    return versionResponse(await this.findVersion(this.db, userId, resumeId, versionId));
  }

  /** What would change if this version replaced the current resume. */
  async diff(userId: string, resumeId: string, versionId: string) {
    this.requireVersions();
    const resume = await this.find(this.db, userId, resumeId);
    const version = await this.findVersion(this.db, userId, resumeId, versionId);
    return { versionId: version.id, number: version.number, changes: this.changes(resume, version) };
  }

  async propose(userId: string, resumeId: string, request: ProposalRequest) {
    this.requireVersions();
    const resume = await this.find(this.db, userId, resumeId);
    if (await this.db.resumeVersion.count({ where: { resumeId: resume.id, status: "PROPOSED" } }) >= MAX_OPEN_PROPOSALS) {
      throw new ApiError(409, "TOO_MANY_PROPOSALS",
        `This resume has ${MAX_OPEN_PROPOSALS} suggestions waiting. Accept or discard some first.`);
    }
    const source: VersionSource = request.source === "AI" || request.source === "IMPORT" ? request.source : "IMPORT";
    const template = request.templateId == null ? resume.templateId : this.documents.template(request.templateId).id;
    const size = request.pageSize ?? resume.pageSize;
    const label = request.label?.trim() ? request.label.trim() : source === "AI" ? "AI suggestion" : "Imported JSON";
    if (request.data == null && (request.document === undefined || request.document === null)) {
      throw new ApiError(400, "PROPOSAL_EMPTY", "Send resume \"data\" or a \"document\".");
    }
    // A document-only proposal keeps the current form content; a data-only proposal uses the form
    const data = request.data != null ? normalize(request.data) : resume.data;
    const document = this.document(request.document);
    return this.db.$transaction(async (tx) => versionResponse(await tx.resumeVersion.create({ data: {
      resumeId: resume.id, userId, number: await nextNumber(tx, resume.id), label, source, status: "PROPOSED",
      templateId: template, pageSize: size, data: asJson(data), document: jsonOrNull(document),
    } })));
  }

  /** Makes the version the resume's content: a proposal is accepted; an older saved version is restored. */
  async accept(userId: string, resumeId: string, versionId: string): Promise<ResumeResponse> {
    this.requireVersions();
    return this.db.$transaction(async (tx) => {
      await this.find(tx, userId, resumeId);
      const version = await this.findVersion(tx, userId, resumeId, versionId);
      const resume = await tx.resume.update({ where: { id: resumeId }, data: {
        templateId: version.templateId, pageSize: version.pageSize, data: asJson(version.data),
        document: jsonOrNull(version.document),
      } });
      if (version.status === "PROPOSED") {
        await tx.resumeVersion.update({ where: { id: version.id }, data: { status: "ACCEPTED" } });
      } else {
        await this.recordVersion(tx, resume, `Restored version ${version.number}`, "RESTORE", "SAVED");
      }
      return response(resume);
    });
  }

  /** Throws away a proposal. History entries can't be discarded. */
  async discard(userId: string, resumeId: string, versionId: string) {
    this.requireVersions();
    const version = await this.findVersion(this.db, userId, resumeId, versionId);
    if (version.status !== "PROPOSED") throw new ApiError(409, "NOT_A_PROPOSAL", "Only suggestions can be discarded.");
    await this.db.resumeVersion.delete({ where: { id: version.id } });
  }

  // ---- helpers ----

  private async find(tx: Tx, userId: string, id: string): Promise<ResumeRow> {
    const resume = await tx.resume.findFirst({ where: { id, userId } });
    if (!resume) throw resumeNotFound();
    return resume;
  }

  private async findVersion(tx: Tx, userId: string, resumeId: string, versionId: string): Promise<VersionRow> {
    const version = await tx.resumeVersion.findFirst({ where: { id: versionId, resumeId, userId } });
    if (!version) throw versionNotFound();
    return version;
  }

  private requireVersions() {
    if (!this.versionsEnabled) throw new ApiError(404, "VERSIONS_DISABLED", "Version history is turned off.");
  }

  private async recordVersion(tx: Tx, resume: ResumeRow, label: string | null, source: VersionSource, status: VersionStatus) {
    if (!this.versionsEnabled) return;
    await tx.resumeVersion.create({ data: {
      resumeId: resume.id, userId: resume.userId, number: await nextNumber(tx, resume.id), label, source, status,
      templateId: resume.templateId, pageSize: resume.pageSize, data: asJson(resume.data), document: jsonOrNull(resume.document),
    } });
    // Keep history bounded: oldest saved versions go first; proposals and accepted proposals are kept
    const old = await tx.resumeVersion.findMany({
      where: { resumeId: resume.id, userId: resume.userId, status: "SAVED" },
      orderBy: { number: "desc" }, skip: MAX_SAVED_VERSIONS, select: { id: true },
    });
    if (old.length > 0) await tx.resumeVersion.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
  }

  /** The document to store: the one sent, or the form merged into the base document (form edits). */
  private requestDocument(request: ResumeRequest): unknown {
    if (request.document !== undefined && request.document !== null) return request.document;
    if (request.baseDocument === undefined || request.baseDocument === null) return null;
    return this.documents.toDocument(request.templateId, request.pageSize, request.data, request.baseDocument);
  }

  /** A request's document, validated and normalized for storage; null when there is none. */
  private document(document: unknown): JsonDoc | null {
    return document === undefined || document === null ? null : this.documents.normalizeDocument(document);
  }

  /**
   * Form-only on both sides: a field-level diff of the form data; otherwise both are compared as documents (a form
   * side is converted first).
   */
  private changes(resume: ResumeRow, version: VersionRow): Change[] {
    if (resume.document == null && version.document == null) {
      return resumeDiff(readResumeJson(resume.data), readResumeJson(version.data));
    }
    const before = (resume.document as JsonDoc | null)
      ?? this.documents.toDocument(resume.templateId, resume.pageSize as PageSize, readResumeJson(resume.data));
    const after = (version.document as JsonDoc | null)
      ?? this.documents.toDocument(version.templateId, version.pageSize as PageSize, readResumeJson(version.data));
    return docDiff(before, after);
  }
}

async function nextNumber(tx: Tx, resumeId: string) {
  const { _max } = await tx.resumeVersion.aggregate({ where: { resumeId }, _max: { number: true } });
  return (_max.number ?? 0) + 1;
}

function response(resume: ResumeRow): ResumeResponse {
  return {
    id: resume.id,
    title: resume.title,
    templateId: resume.templateId,
    pageSize: resume.pageSize as PageSize,
    data: normalize(readResumeJson(resume.data)),
    document: resume.document as JsonDoc | null,
    aiCopy: resume.aiCopy,
    createdAt: resume.createdAt,
    updatedAt: resume.updatedAt,
  };
}

function versionResponse(v: VersionRow) {
  return {
    id: v.id,
    number: v.number,
    label: v.label,
    source: v.source as VersionSource,
    status: v.status as VersionStatus,
    templateId: v.templateId,
    pageSize: v.pageSize as PageSize,
    data: normalize(readResumeJson(v.data)),
    document: v.document as JsonDoc | null,
    createdAt: v.createdAt,
  };
}

export function resumesRouter(resumes: ResumeService, documents: ResumeDocuments, drive: DriveService,
  fields: UserFieldService): Router {
  const router = Router();
  /** The request with the user's saved details ({{github}} …) filled in, for printing. */
  async function withFields<T>(res: Parameters<typeof currentUser>[0], request: T): Promise<T> {
    return fillFields(fields, currentUser(res).id, request);
  }
  const schema = readFileSync(path.join(RESOURCES_DIR, "schema", "resume.schema.json"));
  const resumeId = (req: Parameters<typeof uuidParam>[0]) => uuidParam(req, "id", resumeNotFound());
  const versionId = (req: Parameters<typeof uuidParam>[0]) => uuidParam(req, "versionId", versionNotFound());

  router.get("/templates", (_req, res) => {
    res.json(documents.templates().map((t) => ({ id: t.id, name: t.name, description: t.description })));
  });

  /** JSON Schema of the resume format, for people and AI assistants writing resume JSON. */
  router.get("/schema", (_req, res) => {
    res.type("application/schema+json").send(schema);
  });

  /**
   * Checks resume JSON in either format (current or the original fixed-section one) and returns it cleaned up in the
   * current format, with ids filled in. Used before importing JSON written elsewhere.
   */
  router.post("/normalize", (req, res) => {
    const data = readResumeJson(req.body);
    const result = resumeDataSchema.safeParse(data);
    if (!result.success) throw validationError(fieldErrors(result.error.issues, "data"));
    res.json(normalize(data));
  });

  router.get("/", async (_req, res) => {
    res.json(await resumes.list(currentUser(res).id));
  });

  router.post("/", async (req, res) => {
    const created = await resumes.create(currentUser(res).id, body(req, resumeRequestSchema));
    res.status(201).location(`/api/v1/resumes/${created.id}`).json(created);
  });

  /** The PDF as base64 with its page count, for the editor's page preview (drawn in the browser with pdf.js). */
  router.post("/render/pages", async (req, res) => {
    const request = await withFields(res, body(req, renderRequestSchema));
    const pdf = await documents.renderPdf(request.templateId, request.pageSize, request.data, request.baseDocument);
    res.set("Cache-Control", "no-store").json({ pageCount: pdf.pages, pdf: pdf.bytes.toString("base64") });
  });

  /** The document as HTML, for the editor's live preview (shown in a sandboxed frame). */
  router.post("/render/preview", async (req, res) => {
    const request = await withFields(res, body(req, renderRequestSchema));
    res.type("text/html; charset=utf-8")
      .set("Content-Security-Policy", PREVIEW_CSP)
      .set("Cache-Control", "no-store")
      .send(documents.renderHtml(request.templateId, request.pageSize, request.data, request.baseDocument));
  });

  /** The PDF as a download. */
  router.post("/render/pdf", async (req, res) => {
    const request = await withFields(res, body(req, renderRequestSchema));
    const pdf = await documents.renderPdf(request.templateId, request.pageSize, request.data, request.baseDocument);
    res.status(200)
      .type("application/pdf")
      .set("Content-Disposition", attachment(resumeFileName(request.fileName, request.data)))
      .set("Cache-Control", "no-store")
      .set("X-Document-Pages", String(pdf.pages))
      .send(pdf.bytes);
  });

  /** Generates the PDF and saves it to the user's Google Drive. Retrying with the same requestId is safe. */
  router.post("/render/drive", async (req, res) => {
    const user = currentUser(res);
    const request = await withFields(res, body(req, saveToDriveSchema));
    if (request.resumeId && !(await resumes.isOwnedBy(user.id, request.resumeId))) throw resumeNotFound();
    // A docEngine document, when sent, is what gets printed; otherwise the form data
    const pdf = request.document !== undefined && request.document !== null
      ? await documents.renderDocumentPdf(request.document)
      : await documents.renderPdf(request.templateId, request.pageSize, request.data, request.baseDocument);
    const saved = await drive.uploadPdf(user, request.requestId, resumeFileName(request.fileName, request.data),
      request.folderId, request.resumeId, pdf.bytes);
    res.status(201).json(saved);
  });

  /** The form data as a docEngine document (schema version 3), to continue editing as a document. */
  router.post("/document", (req, res) => {
    const request = body(req, renderRequestSchema);
    res.json(documents.toDocument(request.templateId, request.pageSize, request.data, request.baseDocument));
  });

  /** A document read back into the form (content only; the styling stays in the document). */
  router.post("/form", (req, res) => {
    const document = (req.body as { document?: unknown } | undefined)?.document;
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new ApiError(400, "DOCUMENT_MISSING", "Send { \"document\": { … } }.");
    }
    res.json(documents.toForm(document));
  });

  /** Creates or replaces the AI copy (one per user): the resume an assistant tailors for applications. */
  router.put("/ai-copy", async (req, res) => {
    const { created, ...resume } = await resumes.saveAiCopy(currentUser(res).id, body(req, resumeRequestSchema));
    res.status(created ? 201 : 200).json(resume);
  });

  router.get("/:id", async (req, res) => {
    res.json(await resumes.get(currentUser(res).id, resumeId(req)));
  });

  router.put("/:id", async (req, res) => {
    const id = resumeId(req);
    res.json(await resumes.update(currentUser(res).id, id, body(req, resumeRequestSchema)));
  });

  router.delete("/:id", async (req, res) => {
    await resumes.delete(currentUser(res).id, resumeId(req));
    res.status(204).end();
  });

  // ---- versions: history and proposals ----

  router.get("/:id/versions", async (req, res) => {
    res.json(await resumes.versions(currentUser(res).id, resumeId(req)));
  });

  /** Suggest changes (imported JSON, an AI assistant). The resume changes only when the owner accepts. */
  router.post("/:id/versions", async (req, res) => {
    const id = resumeId(req);
    const version = await resumes.propose(currentUser(res).id, id, body(req, proposalRequestSchema));
    res.status(201).location(`/api/v1/resumes/${id}/versions/${version.id}`).json(version);
  });

  router.get("/:id/versions/:versionId", async (req, res) => {
    res.json(await resumes.version(currentUser(res).id, resumeId(req), versionId(req)));
  });

  router.get("/:id/versions/:versionId/diff", async (req, res) => {
    res.json(await resumes.diff(currentUser(res).id, resumeId(req), versionId(req)));
  });

  /** Accept a proposal, or restore an older version. */
  router.post("/:id/versions/:versionId/accept", async (req, res) => {
    res.json(await resumes.accept(currentUser(res).id, resumeId(req), versionId(req)));
  });

  router.delete("/:id/versions/:versionId", async (req, res) => {
    await resumes.discard(currentUser(res).id, resumeId(req), versionId(req));
    res.status(204).end();
  });

  return router;
}
