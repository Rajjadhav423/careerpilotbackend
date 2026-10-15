import type { EmailTemplate as TemplateModel } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db, Tx } from "../db/prisma.js";
import { ApiError } from "../http/errors.js";
import { body, requiredText, uuidParam } from "../http/validate.js";
import type { UserFieldService } from "../users/fields.js";
import { invalidPlaceholders, MERGE_FIELDS, mergeFieldResponses, resolve } from "./merge-fields.js";

/* The signed-in user's email templates. Templates of other users are never visible (404). */

/** Generous for personal use; stops runaway creation. */
export const MAX_TEMPLATES_PER_USER = 100;

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** The API shape (no owner id). */
const toTemplate = ({ userId: _owner, ...template }: TemplateModel): EmailTemplate => template;

/** A subject is one line: line breaks would allow email header injection. */
const singleLine = (schema: z.ZodString) => schema.regex(/^[^\r\n]*$/, "must be a single line");

/** Create or replace a template. Placeholders must be allowlisted merge fields. */
export const templateSchema = z.object({
  name: requiredText(100),
  subject: requiredText(255).pipe(singleLine(z.string())),
  body: requiredText(20_000),
  isDefault: z.boolean().nullish().transform((value) => value ?? false),
});

export const previewSchema = z.object({
  subject: z.string().max(255, "size must be between 0 and 255").nullish(),
  body: z.string().max(20_000, "size must be between 0 and 20000").nullish(),
});

export type TemplateRequest = z.infer<typeof templateSchema>;

const notFound = () => new ApiError(404, "TEMPLATE_NOT_FOUND", "Template not found.");

export class TemplateService {
  constructor(private readonly db: Db, private readonly fields?: UserFieldService) {}

  /** The user's saved details (Settings), usable as {{key}} in templates. */
  async detailValues(userId: string): Promise<Record<string, string>> {
    return this.fields ? this.fields.values(userId) : {};
  }

  /** Default template first, then by name. */
  async list(userId: string): Promise<EmailTemplate[]> {
    const templates = await this.db.emailTemplate.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    return templates.map(toTemplate);
  }

  async get(userId: string, id: string): Promise<EmailTemplate> {
    const template = await this.db.emailTemplate.findFirst({ where: { id, userId } });
    if (!template) throw notFound();
    return toTemplate(template);
  }

  async findDefault(userId: string): Promise<EmailTemplate | null> {
    const template = await this.db.emailTemplate.findFirst({ where: { userId, isDefault: true } });
    return template ? toTemplate(template) : null;
  }

  async create(userId: string, request: TemplateRequest): Promise<EmailTemplate> {
    requireOnlyAllowlistedPlaceholders(request.subject, request.body, new Set(Object.keys(await this.detailValues(userId))));
    return this.db.$transaction(async (tx) => {
      await requireBelowLimit(tx, userId);
      if (request.isDefault) await tx.emailTemplate.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return toTemplate(await tx.emailTemplate.create({ data: {
        userId, name: request.name.trim(), subject: request.subject.trim(), body: request.body, isDefault: request.isDefault,
      } }));
    });
  }

  async update(userId: string, id: string, request: TemplateRequest): Promise<EmailTemplate> {
    await this.get(userId, id);
    requireOnlyAllowlistedPlaceholders(request.subject, request.body, new Set(Object.keys(await this.detailValues(userId))));
    return this.db.$transaction(async (tx) => {
      if (request.isDefault) {
        await tx.emailTemplate.updateMany({ where: { userId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      }
      return toTemplate(await tx.emailTemplate.update({ where: { id }, data: {
        name: request.name.trim(), subject: request.subject.trim(), body: request.body, isDefault: request.isDefault,
      } }));
    });
  }

  /** Copies a template ("Copy of …"); the copy is never the default. */
  async duplicate(userId: string, id: string): Promise<EmailTemplate> {
    const original = await this.get(userId, id);
    return this.db.$transaction(async (tx) => {
      await requireBelowLimit(tx, userId);
      return toTemplate(await tx.emailTemplate.create({ data: {
        userId, name: `Copy of ${original.name}`.slice(0, 100), subject: original.subject, body: original.body, isDefault: false,
      } }));
    });
  }

  async delete(userId: string, id: string): Promise<void> {
    const { count } = await this.db.emailTemplate.deleteMany({ where: { id, userId } });
    if (!count) throw notFound();
  }
}

async function requireBelowLimit(tx: Tx, userId: string) {
  if (await tx.emailTemplate.count({ where: { userId } }) >= MAX_TEMPLATES_PER_USER) {
    throw new ApiError(400, "TEMPLATE_LIMIT_REACHED",
      `You can keep up to ${MAX_TEMPLATES_PER_USER} templates. Delete one to add another.`);
  }
}

/** Fills every merge field with sample data (saved details with their real values), for the editor's preview. */
export function previewTemplate(subject: string | null | undefined, body: string | null | undefined,
  details: Record<string, string> = {}) {
  const samples = { ...Object.fromEntries(MERGE_FIELDS.map((field) => [field.key, field.sample])), ...details };
  const s = resolve(subject ?? "", samples);
  const b = resolve(body ?? "", samples);
  return { subject: s.text, body: b.text, unknownPlaceholders: [...new Set([...s.unknown, ...b.unknown])] };
}

function requireOnlyAllowlistedPlaceholders(subject: string, body: string, details: ReadonlySet<string> = new Set()) {
  const invalid = [...new Set([...invalidPlaceholders(subject, details), ...invalidPlaceholders(body, details)])];
  if (invalid.length > 0) {
    throw new ApiError(400, "UNKNOWN_PLACEHOLDERS",
      `These placeholders aren't supported: ${invalid.join(", ")}. Use Insert field, or add the detail in Settings.`);
  }
}

export function templatesRouter(templates: TemplateService): Router {
  const router = Router();

  /** The supported merge fields (the allowlist), for the editor's insert menu. */
  router.get("/merge-fields", (_req, res) => {
    res.json(mergeFieldResponses());
  });

  router.get("/", async (_req, res) => {
    res.json(await templates.list(currentUser(res).id));
  });

  router.post("/", async (req, res) => {
    const created = await templates.create(currentUser(res).id, body(req, templateSchema));
    res.status(201).location(`/api/v1/email-templates/${created.id}`).json(created);
  });

  /** Fills merge fields with sample data. Nothing is saved. */
  router.post("/preview", async (req, res) => {
    const request = body(req, previewSchema);
    res.json(previewTemplate(request.subject, request.body, await templates.detailValues(currentUser(res).id)));
  });

  router.get("/:id", async (req, res) => {
    res.json(await templates.get(currentUser(res).id, uuidParam(req, "id", notFound())));
  });

  router.put("/:id", async (req, res) => {
    const id = uuidParam(req, "id", notFound());
    res.json(await templates.update(currentUser(res).id, id, body(req, templateSchema)));
  });

  router.post("/:id/duplicate", async (req, res) => {
    const copy = await templates.duplicate(currentUser(res).id, uuidParam(req, "id", notFound()));
    res.status(201).location(`/api/v1/email-templates/${copy.id}`).json(copy);
  });

  router.delete("/:id", async (req, res) => {
    await templates.delete(currentUser(res).id, uuidParam(req, "id", notFound()));
    res.status(204).end();
  });

  return router;
}
