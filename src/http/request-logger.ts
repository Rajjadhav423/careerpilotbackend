import type { NextFunction, Request, Response } from "express";

/* Logs each request the way Next.js's dev server does: "GET /path 200 in 12ms". */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function colorForStatus(status: number): string {
  if (status >= 500) return RED;
  if (status >= 400) return YELLOW;
  return GREEN;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const color = colorForStatus(res.statusCode);
    const caller = req.ip ?? req.socket.remoteAddress ?? "unknown";
    console.info(
      `${color}${req.method}${RESET} ${req.originalUrl} ${color}${res.statusCode}${RESET} in ${durationMs.toFixed(0)}ms ${DIM}- ${caller}${RESET}`,
    );
  });
  next();
}
