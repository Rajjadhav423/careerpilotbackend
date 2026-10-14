import { readFileSync } from "node:fs";
import path from "node:path";

import { RESOURCES_DIR } from "./fonts.js";
import type { StyleMap } from "./model.js";
import { readDoc, type PresetStyles } from "./reader.js";

/*
 * Ready-made style sets a document can start from ("preset": "classic"). Each is a JSON file in docengine/presets/
 * with id, name, description and styles; the styles follow exactly the same rules as a document's own and are
 * validated at startup. To add one: create the file and list its id in PRESET_IDS.
 */

const PRESET_IDS = ["classic", "modern"];

export type Preset = { id: string; name: string; description: string; styles: Record<string, StyleMap> };

export class DocPresets {
  private readonly presets = new Map<string, Preset>();

  constructor(dir = path.join(RESOURCES_DIR, "presets")) {
    for (const id of PRESET_IDS) this.presets.set(id, load(dir, id));
  }

  all(): Preset[] {
    return [...this.presets.values()];
  }

  find(id: string | null | undefined): Preset | null {
    return id == null ? null : this.presets.get(id) ?? null;
  }

  /** Preset id → styles, for the reader. */
  stylesById(): PresetStyles {
    return Object.fromEntries([...this.presets].map(([id, preset]) => [id, preset.styles]));
  }
}

function load(dir: string, id: string): Preset {
  let file: { name?: string; description?: string; styles?: unknown };
  try {
    file = JSON.parse(readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch (error) {
    throw new Error(`Missing document preset ${id}: ${(error as Error).message}`);
  }
  // Validate the styles with the document rules: a minimal document that uses them
  const probe = { schemaVersion: 3, document: "resume", styles: file.styles, sections: [{ id: "probe", nodes: [] }] };
  const result = readDoc(probe, "STRICT", {});
  if (!result.doc) throw new Error(`Preset ${id} breaks the document rules: ${JSON.stringify(result.errors)}`);
  return {
    id,
    name: typeof file.name === "string" ? file.name : id,
    description: typeof file.description === "string" ? file.description : "",
    styles: result.doc.styles,
  };
}
