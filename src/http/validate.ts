import type { Request } from "express";
import { z, type ZodTypeAny } from "zod";

import { ApiError, fieldErrors, validationError } from "./errors.js";

/** Parses the JSON body with a zod schema; 400 VALIDATION_FAILED with field errors otherwise. */
export function body<T extends ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) throw validationError(fieldErrors(result.error.issues));
  return result.data;
}

/** Path parameter that must be a UUID; anything else behaves like a missing record (404). */
export function uuidParam(req: Request, name: string, notFound: ApiError): string {
  const value = req.params[name];
  if (typeof value !== "string" || !UUID.test(value)) throw notFound;
  return value.toLowerCase();
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query parameter as a string (first value), or undefined. */
export function query(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** A query flag: "true" → true, anything else → the default. */
export function flag(req: Request, name: string, fallback = false): boolean {
  const value = query(req, name);
  return value === undefined ? fallback : value === "true";
}

// ---- reusable field schemas (same rules and messages as the Spring backend) ----

/** Optional text with a max length; null/absent allowed. */
export const optionalText = (max: number) =>
  z.string().max(max, `size must be between 0 and ${max}`).nullish();

/** Required, not blank, max length. */
export const requiredText = (max: number) =>
  z.string({ required_error: "must not be blank", invalid_type_error: "must not be blank" })
    .max(max, `size must be between 0 and ${max}`)
    .refine((value) => value.trim().length > 0, "must not be blank");

/** http(s) URL or empty (empty clears the field). */
export const httpUrlOrEmpty = (max: number) =>
  z.string().max(max, `size must be between 0 and ${max}`)
    .regex(/^$|^https?:\/\/\S+$/, "must be a valid http(s) URL")
    .nullish();
