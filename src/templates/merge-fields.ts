/*
 * The only placeholders a template may contain, written as {{key}}. Anything else is rejected when a template is
 * saved and blocks sending. `sample` values are used for previews only, never for real emails.
 * Plain text substitution only: template content is never evaluated, and values are inserted as literal text
 * (HTML escaping happens when the email is built).
 */

export type MergeField = {
  key: string;
  label: string;
  description: string;
  sample: string;
};

export const MERGE_FIELDS: readonly MergeField[] = [
  { key: "candidate_name", label: "Your name", description: "Your name from your account", sample: "Priya Sharma" },
  { key: "candidate_email", label: "Your email", description: "Your account email address", sample: "priya@example.com" },
  {
    key: "resume_url",
    label: "Resume link",
    description: "Link to your resume (not available yet: the resume library comes later)",
    sample: "https://example.com/priya-sharma-resume.pdf",
  },
  { key: "job_title", label: "Job title", description: "Title of the selected job", sample: "Backend Engineer" },
  { key: "company_name", label: "Company", description: "Company of the selected job", sample: "Northwind Labs" },
  { key: "job_location", label: "Job location", description: "Location of the selected job", sample: "Bengaluru" },
  {
    key: "job_url",
    label: "Job posting link",
    description: "The job's link",
    sample: "https://jobs.example.com/backend-engineer",
  },
  {
    key: "application_url",
    label: "Application link",
    description: "Where to apply: the job's link (CareerPilot stores one link per job)",
    sample: "https://jobs.example.com/backend-engineer",
  },
  {
    key: "application_date",
    label: "Application date",
    description: "The date the application was sent, or today when composing a new one",
    sample: "11 October 2026",
  },
];

export type MergeFieldKey = string;

export const placeholder = (key: string) => `{{${key}}}`;

const byKey = new Map(MERGE_FIELDS.map((field) => [field.key, field]));
export const isMergeField = (key: string) => byKey.has(key);

/** For the editor's insert menu. */
export const mergeFieldResponses = () =>
  MERGE_FIELDS.map((field) => ({ ...field, placeholder: placeholder(field.key) }));

/** Bounded and non-nested, so matching stays linear even on hostile input. */
const PLACEHOLDER = /\{\{([^{}\r\n]{0,64})\}\}/g;

export type Resolution = {
  /** Placeholders filled where a value was available */
  text: string;
  /** Allowlisted fields that had no value; their placeholders stay in the text */
  missing: string[];
  /** Placeholders that are not allowlisted (or malformed brace fragments), left in the text */
  unknown: string[];
};

/** Fills allowlisted placeholders that have a non-blank value; never invents values for the rest. */
export function resolve(text: string, values: Record<string, string | null | undefined>): Resolution {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const out = text.replace(PLACEHOLDER, (match, inner: string) => {
    const key = inner.trim();
    if (!isMergeField(key)) {
      unknown.add(match);
      return match;
    }
    const value = values[key];
    if (value == null || value.trim() === "") {
      missing.add(key);
      return placeholder(key);
    }
    return value;
  });
  for (const stray of strayBraces(text)) unknown.add(stray);
  return { text: out, missing: orderByField(missing), unknown: [...unknown] };
}

/** Placeholders a template may not contain: not allowlisted, or malformed braces such as "{{job_title". */
export function invalidPlaceholders(text: string): string[] {
  const invalid = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!isMergeField(match[1]!.trim())) invalid.add(match[0]);
  }
  for (const stray of strayBraces(text)) invalid.add(stray);
  return [...invalid];
}

/** Every placeholder-like fragment still in a composed email. Sending is blocked while any remain. */
export function remainingPlaceholders(text: string): string[] {
  const remaining = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) remaining.add(match[0]);
  for (const stray of strayBraces(text)) remaining.add(stray);
  return [...remaining];
}

/** "{{" or "}}" left over after removing well-formed placeholders. */
function strayBraces(text: string): string[] {
  const rest = text.replace(PLACEHOLDER, "");
  const stray: string[] = [];
  if (rest.includes("{{")) stray.push("{{");
  if (rest.includes("}}")) stray.push("}}");
  return stray;
}

const orderByField = (keys: Set<string>) => MERGE_FIELDS.map((field) => field.key).filter((key) => keys.has(key));
