import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, type ZodIssue } from "zod";

/*
 * Every API error has one JSON shape (RFC 9457 ProblemDetail, same as the Spring backend):
 *   { "title", "status", "detail", "code"?, "errors"?, ...details }
 * The frontend switches on `code` and shows `errors` (field → message) next to form fields.
 */

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Content",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** An expected failure with a status and a stable code, e.g. 404 JOB_NOT_FOUND. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra ProblemDetail properties, e.g. { issues } for a rejected document */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function problem(status: number, detail: string, extra: Record<string, unknown> = {}) {
  return { title: TITLES[status] ?? "Error", status, detail, ...extra };
}

/** zod issues → { "data.basics.fullName": "is required", "links[0].url": "…" } (first message per field). */
export function fieldErrors(issues: ZodIssue[], prefix = ""): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    let path = prefix;
    for (const part of issue.path) {
      path += typeof part === "number" ? `[${part}]` : path ? `.${part}` : String(part);
    }
    const key = path || "body";
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

export function validationError(errors: Record<string, string>) {
  return new ApiError(400, "VALIDATION_FAILED", "Some fields are invalid.", { title: "Validation failed", errors });
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).type("application/problem+json").json(problem(404, "No such endpoint.", { code: "NOT_FOUND" }));
};

/** Turns thrown errors into ProblemDetail responses. Unexpected errors are logged without request bodies. */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  const send = (status: number, body: Record<string, unknown>) =>
    res.status(status).type("application/problem+json").json(body);

  if (error instanceof ApiError) {
    return send(error.status, problem(error.status, error.message, { code: error.code, ...error.details }));
  }
  if (error instanceof ZodError) {
    return send(400, problem(400, "Some fields are invalid.", { title: "Validation failed", code: "VALIDATION_FAILED",
      errors: fieldErrors(error.issues) }));
  }
  // body-parser errors
  const type = (error as { type?: string }).type;
  if (type === "entity.too.large") {
    return send(413, problem(413, "This request is too large.", { code: "REQUEST_TOO_LARGE" }));
  }
  if (type === "entity.parse.failed") {
    return send(400, problem(400, "The request body isn't valid JSON.", { code: "MALFORMED_JSON" }));
  }
  // Unique violation (Prisma P2002), e.g. the same posting saved twice at the same moment
  if ((error as { code?: string }).code === "P2002") {
    return send(409, problem(409, "This conflicts with existing data. Refresh and try again.", { code: "CONFLICT" }));
  }
  console.error(`Unhandled error on ${req.method} ${req.path}:`, error instanceof Error ? error.stack : error);
  return send(500, problem(500, "Something went wrong. Please try again.", { code: "INTERNAL_ERROR" }));
};
