/*
 * Decides from a job title (and department) whether a posting is a tech job, and which kind.
 * Rules are checked in order; the first match wins, so specific roles come before GENERAL.
 */

/** Kind of tech job. GENERAL is software engineering without a clearer specialism. */
export const TECH_ROLES = [
  "BACKEND", "FRONTEND", "FULL_STACK", "MOBILE", "DEVOPS", "DATA_ML", "QA", "SECURITY", "GENERAL",
] as const;
export type TechRole = (typeof TECH_ROLES)[number];

/** Case-insensitive match of any alternative as whole words. */
const words = (...alternatives: string[]) => new RegExp(`\\b(${alternatives.join("|")})\\b`, "i");

/** Non-tech, pre-sales or manager-of-product work, even if the title says "engineer" or "security". */
const EXCLUDED = words(
  "sales", "pre-?sales", "account (executive|manager|director)", "business development", "marketing",
  "go[ -]to[ -]market", "gtm", "recruit(er|ing|ment)?", "talent", "legal", "counsel", "finance",
  "accountant", "accounting", "audit", "payroll", "tax", "people partner", "human resources",
  "customer success", "solutions? (engineer|architect|consultant)", "field engineer", "customer engineer",
  "(technical )?program manager", "product manag(er|ement)", "project manager",
  "physical security", "security officer", "mechanical", "electrical", "hardware", "civil", "manufacturing",
  "facilit(y|ies)",
  "technician",
);

const RULES: { role: TechRole; pattern: RegExp }[] = [
  { role: "QA", pattern: words("qa", "quality assurance", "sdet", "test engineer", "test automation",
    "automation test(ing|er)?", "engineer in test") },
  { role: "SECURITY", pattern: words("security", "appsec", "penetration", "pentest(er|ing)?") },
  { role: "DATA_ML", pattern: words("machine learning", "ml", "mlops", "ai engineer", "ai/ml", "llm",
    "deep learning", "nlp", "computer vision", "data (engineer|scientist|platform|infrastructure)",
    "analytics engineer", "research (engineer|scientist)") },
  { role: "DEVOPS", pattern: words("devops", "sre", "site reliability", "reliability engineer",
    "platform engineer(ing)?", "infrastructure", "cloud engineer", "production engineer",
    "kubernetes", "(?<!distributed )systems engineer", "network engineer", "release engineer",
    "build engineer") },
  { role: "MOBILE", pattern: words("android", "ios", "mobile", "flutter", "react native") },
  { role: "FULL_STACK", pattern: words("full[ -]?stack") },
  { role: "FRONTEND", pattern: words("front[ -]?end", "ui engineer", "web developer", "react", "angular", "vue") },
  { role: "BACKEND", pattern: words("back[ -]?end", "server[ -]side", "api", "distributed systems",
    "java", "golang", "microservices", "node\\.?js", "django", "spring") },
  { role: "GENERAL", pattern: words("software", "engineer", "engineering", "developer", "sde", "swe",
    "programmer", "member of technical staff", "tech lead", "architect") },
];

const ENGINEERING_DEPARTMENT = words("engineering", "technology", "r&d");

/** The kind of tech job, or null for non-tech postings. */
export function classify(title: string | null | undefined, department: string | null | undefined): TechRole | null {
  const safeTitle = title ?? "";
  const safeDepartment = department ?? "";
  if (EXCLUDED.test(safeTitle) || EXCLUDED.test(safeDepartment)) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(safeTitle)) return rule.role;
  }
  // e.g. an unusual title inside an "Engineering" team
  return ENGINEERING_DEPARTMENT.test(safeDepartment) ? "GENERAL" : null;
}
