import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Fonts bundled with the engine (SIL Open Font License, files in docengine/fonts/). Documents may only use these
 * families: they're embedded in every PDF, so text stays selectable and readable by applicant tracking systems,
 * and nothing is downloaded. To add a family: drop its .ttf files (400, 400 italic, 600, 700) and OFL licence into
 * the folder and list them here.
 */

/** The docengine/ resources folder (fonts, presets, schema, rules) at the project root. */
export const RESOURCES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docengine");
export const FONTS_DIR = path.join(RESOURCES_DIR, "fonts");

export type BundledFont = { file: string; family: string; weight: number; style: "normal" | "italic" };

export const FONT_FILES: readonly BundledFont[] = [
  { file: "Inter-Regular.ttf", family: "Inter", weight: 400, style: "normal" },
  { file: "Inter-Italic.ttf", family: "Inter", weight: 400, style: "italic" },
  { file: "Inter-SemiBold.ttf", family: "Inter", weight: 600, style: "normal" },
  { file: "Inter-Bold.ttf", family: "Inter", weight: 700, style: "normal" },
  { file: "SourceSerif4-Regular.ttf", family: "Source Serif 4", weight: 400, style: "normal" },
  { file: "SourceSerif4-Italic.ttf", family: "Source Serif 4", weight: 400, style: "italic" },
  { file: "SourceSerif4-SemiBold.ttf", family: "Source Serif 4", weight: 600, style: "normal" },
  { file: "SourceSerif4-Bold.ttf", family: "Source Serif 4", weight: 700, style: "normal" },
];

/** Family name (as written in CSS) → generic fallback. Generic names map to a bundled family. */
const FAMILIES: [string, string][] = [
  ["Inter", "sans-serif"],
  ["Source Serif 4", "serif"],
];

export const DEFAULT_FAMILY = "Inter";

export const fontFamilies = () => FAMILIES.map(([family]) => family);

/**
 * The bundled family for a name in a font-family list: an exact family (any case), or a generic name
 * ("sans-serif" → Inter, "serif" → Source Serif 4). Null if we don't have it.
 */
export function resolveFont(name: string): string | null {
  const wanted = name.trim().toLowerCase();
  return FAMILIES.find(([family]) => family.toLowerCase() === wanted)?.[0]
    ?? FAMILIES.find(([, generic]) => generic === wanted)?.[0]
    ?? null;
}
