import { readFileSync } from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import type { Browser, HTTPRequest, Page } from "puppeteer";

import { ApiError } from "../http/errors.js";
import { FONT_FILES, FONTS_DIR } from "./fonts.js";

/*
 * Prints XHTML from the writer to PDF with headless Chromium (Puppeteer).
 *
 * Safety and resource limits:
 * - No external resources: every network request from the page is refused except our own bundled fonts, which
 *   are answered from memory. A document can never make the server fetch a URL or read a local file (no SSRF).
 *   JavaScript is disabled in the page.
 * - Fonts are our bundled OFL fonts, embedded in the PDF, so text stays selectable and searchable (ATS).
 *   Ligatures are turned off so "Software" is never extracted as "So ware".
 * - Rendering is limited to a few at a time with a small queue, a timeout and caps on size and page count.
 */

/** Never fetched from the internet: fonts are served from memory under this origin. */
const FONT_ORIGIN = "https://fonts.careerpilot.invalid/";

/** Sharp enough on phones and laptops; an A4 page is about 990 × 1400 pixels. */
export const PREVIEW_DPI = 120;

export type RenderedPdf = { bytes: Buffer; pages: number };

export type PdfLimits = {
  maxPages: number;
  maxBytes: number;
  renderTimeoutMs: number;
  maxConcurrent: number;
  maxQueued: number;
  executablePath: string | null;
};

/** The pieces of PDF work that tests can replace. */
export interface PdfRenderer {
  convert(xhtml: string): Promise<RenderedPdf>;
  pageImages(pdf: Uint8Array): Promise<Buffer[]>;
  close(): Promise<void>;
}

const FONT_CSS = FONT_FILES.map((font) =>
  `@font-face { font-family: "${font.family}"; src: url("${FONT_ORIGIN}${font.file}") format("truetype"); `
  + `font-weight: ${font.weight}; font-style: ${font.style}; }`).join("\n")
  // Plain glyphs keep the PDF text exact for copy-paste and applicant tracking systems
  + "\n* { font-variant-ligatures: none; font-feature-settings: \"liga\" 0, \"clig\" 0, \"dlig\" 0; }\n";

const busy = () => new ApiError(503, "DOCUMENT_BUSY",
  "Lots of documents are being created right now. Please try again in a moment.");
const timedOut = () => new ApiError(503, "DOCUMENT_TIMEOUT",
  "Creating the PDF took too long. Try a shorter document or try again.");

/** At most `concurrent` tasks at once and `queued` waiting; more are refused straight away. */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly concurrent: number, private readonly queued: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrent) {
      if (this.waiting.length >= this.queued) throw busy();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/** Rejects with `onTimeout()` when `work` takes longer than `ms`; `cleanup` runs either way. */
export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | null = null;
  private readonly fonts = new Map<string, Buffer>();
  private readonly limiter: Limiter;

  constructor(private readonly limits: PdfLimits) {
    for (const font of FONT_FILES) this.fonts.set(font.file, readFileSync(path.join(FONTS_DIR, font.file)));
    this.limiter = new Limiter(limits.maxConcurrent, Math.max(1, limits.maxQueued));
  }

  /**
   * Throws 422 when the document is too long or large, 503 when the server is busy or rendering timed out,
   * 500 when rendering failed.
   */
  convert(xhtml: string): Promise<RenderedPdf> {
    return this.onPool(() => this.render(xhtml));
  }

  /**
   * Draws each page of a PDF we generated as a PNG (same limits as convert). Used for the preview, so it shows
   * exactly what the PDF will look like, page breaks included.
   */
  pageImages(pdf: Uint8Array): Promise<Buffer[]> {
    return this.onPool(() => renderPageImages(pdf, this.limits.maxPages));
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    if (browser) await (await browser.catch(() => null))?.close().catch(() => undefined);
  }

  private async onPool<T>(task: () => Promise<T>): Promise<T> {
    return this.limiter.run(async () => {
      try {
        return await withTimeout(task(), this.limits.renderTimeoutMs, timedOut);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "DOCUMENT_TIMEOUT") console.warn(`PDF rendering timed out after ${this.limits.renderTimeoutMs} ms`);
          throw error;
        }
        // Error name only: the message could quote document content
        console.warn(`PDF rendering failed: ${(error as Error)?.name ?? "unknown"}`);
        throw new ApiError(500, "DOCUMENT_RENDER_FAILED", "We couldn't create the PDF. Please try again.");
      }
    });
  }

  /** One shared browser, started on first use and again if it crashed or failed to start. */
  private async launch(): Promise<Browser> {
    if (this.browser) {
      const running = await this.browser.catch(() => null);
      if (running?.connected) return running;
      this.browser = null;
    }
    this.browser ??= import("puppeteer").then(({ default: puppeteer }) => puppeteer.launch({
      headless: true,
      executablePath: this.limits.executablePath ?? undefined,
      // Small hosts and containers: no setuid sandbox, /tmp instead of a tiny /dev/shm. Pages never load
      // anything from the network and run no JavaScript.
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"],
    }));
    return this.browser;
  }

  private async render(xhtml: string): Promise<RenderedPdf> {
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await this.isolate(page);
      await page.setContent(withFonts(xhtml), { waitUntil: "load" });
      const bytes = Buffer.from(await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: false,
        tagged: true,
        outline: false,
      }));
      if (bytes.length > this.limits.maxBytes) {
        throw new ApiError(422, "DOCUMENT_TOO_LARGE", "This document is too large to create. Shorten some sections and try again.");
      }
      const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
      if (pages > this.limits.maxPages) {
        throw new ApiError(422, "DOCUMENT_TOO_LONG", `This document would be ${pages} pages. The limit is `
          + `${this.limits.maxPages}; shorten some sections and try again.`);
      }
      return { bytes, pages };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** No scripts, and every request refused except our in-memory fonts. */
  private async isolate(page: Page) {
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    // Typed locally: Puppeteer's event names are const enums, which isolatedModules can't import
    (page as unknown as { on(event: "request", handler: (request: HTTPRequest) => void): void }).on("request", (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const url = request.url();
      const font = url.startsWith(FONT_ORIGIN) ? this.fonts.get(url.slice(FONT_ORIGIN.length)) : undefined;
      if (font) {
        void request.respond({ status: 200, contentType: "font/ttf", body: font });
      } else if (url.startsWith("data:")) {
        void request.continue();
      } else {
        void request.abort("blockedbyclient");
      }
    });
  }
}

/** The bundled @font-face rules go first, so document styles can use the families. */
export function withFonts(xhtml: string): string {
  return xhtml.replace("<style>\n", `<style>\n${FONT_CSS}`);
}

type PdfJsPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(params: unknown): { promise: Promise<void> };
  cleanup(): void;
};
type PdfJs = {
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{ numPages: number; getPage(number: number): Promise<PdfJsPage>; destroy(): Promise<void> }>;
  };
};

/** PNG of every page (up to maxPages) with pdf.js drawing on @napi-rs/canvas. */
export async function renderPageImages(pdf: Uint8Array, maxPages: number): Promise<Buffer[]> {
  // The legacy build runs on every supported Node version; typed locally (only these calls are used)
  const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
  const pdfjs = (await import(specifier)) as PdfJs;
  const { createCanvas } = await import("@napi-rs/canvas");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const images: Buffer[] = [];
    const pages = Math.min(document.numPages, maxPages);
    for (let number = 1; number <= pages; number++) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: PREVIEW_DPI / 72 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      // @napi-rs/canvas implements the 2D context pdf.js needs
      await page.render({ canvasContext: context, canvas, viewport }).promise;
      images.push(await canvas.encode("png"));
      page.cleanup();
    }
    return images;
  } finally {
    await document.destroy();
  }
}
