import { Router } from "express";
import { z } from "zod";

import { currentUser } from "../auth/clerk.js";
import type { Db } from "../db/prisma.js";
import { ApiError } from "../http/errors.js";
import { body } from "../http/validate.js";

/*
 * Reusable details a user fills in once in Settings (GitHub, LinkedIn, LeetCode, portfolio, phone …) and writes as
 * {{key}} in any resume field or document. Placeholders are stored as written and resolved when a preview or PDF is
 * made, so changing a value in Settings updates every resume.
 */

export const MAX_FIELDS = 50;
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** {{ key }} anywhere in a string */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;

export type UserField = { key: string; label: string; value: string };

export const fieldsSchema = z.object({
  fields: z.array(z.object({
    key: z.string({ required_error: "is required" })
      .regex(FIELD_KEY, "use lower-case letters, digits and _ (start with a letter, at most 40)"),
    label: z.string({ required_error: "is required" }).trim().min(1, "is required").max(60, "size must be between 0 and 60"),
    value: z.string({ required_error: "is required" }).max(500, "size must be between 0 and 500")
      .refine((v) => !/[\r\n]/.test(v), "must be a single line"),
  })).max(MAX_FIELDS, `size must be between 0 and ${MAX_FIELDS}`),
});

export class UserFieldService {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<UserField[]> {
    return this.db.userField.findMany({
      where: { userId },
      orderBy: { position: "asc" },
      select: { key: true, label: true, value: true },
    });
  }

  /** Replaces the whole list (the Settings page saves it in one go). */
  async replace(userId: string, fields: UserField[]): Promise<UserField[]> {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) {
        throw new ApiError(400, "FIELD_KEY_DUPLICATE", `"{{${field.key}}}" is used twice; each field needs its own key.`);
      }
      seen.add(field.key);
    }
    await this.db.$transaction(async (tx) => {
      await tx.userField.deleteMany({ where: { userId } });
      if (fields.length > 0) {
        await tx.userField.createMany({
          data: fields.map((field, position) => ({ userId, key: field.key, label: field.label.trim(), value: field.value.trim(), position })),
        });
      }
    });
    return this.list(userId);
  }

  /** key → value, for resolving placeholders. */
  async values(userId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.list(userId)).map((field) => [field.key, field.value]));
  }
}

/**
 * Replaces {{key}} in every string of a JSON value (resume data or a document) with the user's field values.
 * Unknown keys stay as written.
 */
export function resolveFields<T>(value: T, values: Record<string, string>): T {
  if (Object.keys(values).length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.includes("{{") ? node.replace(PLACEHOLDER, (match, key: string) => values[key] ?? match) : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** resolveFields with the user's values; no database lookup when nothing in the value uses a placeholder. */
export async function fillFields<T>(service: UserFieldService, userId: string, value: T): Promise<T> {
  if (!JSON.stringify(value ?? null).includes("{{")) return value;
  return resolveFields(value, await service.values(userId));
}

/** Mounted at /api/v1/me/fields. */
export function userFieldsRouter(fields: UserFieldService): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    res.json(await fields.list(currentUser(res).id));
  });

  router.put("/", async (req, res) => {
    res.json(await fields.replace(currentUser(res).id, body(req, fieldsSchema).fields));
  });

  return router;
}
