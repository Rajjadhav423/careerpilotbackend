/*
 * A fixed list of tech skills, used to read both job posts and resumes, so the match score compares like with like
 * ("Node", "node.js" and "NodeJS" are all "Node.js"). Free and instant: no AI call per job.
 */

/** Display name → whole-word patterns that mean it (case-insensitive). */
const SKILLS: [name: string, pattern: string][] = [
  // Languages
  ["JavaScript", "javascript|ecmascript|es6"],
  ["TypeScript", "typescript"],
  ["Java", "java(?![ -]?script)"],
  ["Kotlin", "kotlin"],
  ["Python", "python"],
  ["Go", "golang|go(?= developer| engineer| programming)"],
  ["Rust", "rust"],
  ["C++", "c\\+\\+|cpp"],
  ["C#", "c#|csharp"],
  ["C", "c(?= programming| language)"],
  ["Ruby", "ruby"],
  ["PHP", "php"],
  ["Scala", "scala"],
  ["Swift", "swift"],
  ["Dart", "dart"],
  ["Elixir", "elixir"],
  ["SQL", "sql"],
  ["Bash", "bash|shell scripting"],
  // Frontend
  ["React", "react(?:\\.?js)?(?! native)"],
  ["Next.js", "next\\.?js"],
  ["Angular", "angular(?:js)?"],
  ["Vue", "vue(?:\\.?js)?"],
  ["Svelte", "svelte"],
  ["Redux", "redux"],
  ["HTML", "html5?"],
  ["CSS", "css3?|scss|sass"],
  ["Tailwind CSS", "tailwind(?: ?css)?"],
  // Backend
  ["Node.js", "node(?:\\.?js)?"],
  ["Express", "express\\.?js"],
  ["NestJS", "nest\\.?js"],
  ["Spring Boot", "spring(?: boot| framework| mvc| cloud)"],
  ["Django", "django"],
  ["Flask", "flask"],
  ["FastAPI", "fastapi"],
  ["Ruby on Rails", "rails|ruby on rails"],
  [".NET", "\\.net|dotnet|asp\\.net"],
  ["Laravel", "laravel"],
  ["GraphQL", "graphql"],
  ["REST APIs", "restful(?: apis?)?|rest apis?"],
  ["gRPC", "grpc"],
  ["Microservices", "micro-?services?"],
  // Mobile
  ["React Native", "react native"],
  ["Flutter", "flutter"],
  ["Android", "android"],
  ["iOS", "ios"],
  // Data and ML
  ["PostgreSQL", "postgres(?:ql)?"],
  ["MySQL", "mysql"],
  ["MongoDB", "mongo(?:db)?"],
  ["Redis", "redis"],
  ["Elasticsearch", "elastic ?search|opensearch"],
  ["DynamoDB", "dynamo ?db"],
  ["Cassandra", "cassandra"],
  ["Kafka", "kafka"],
  ["RabbitMQ", "rabbit ?mq"],
  ["Spark", "spark|pyspark"],
  ["Airflow", "airflow"],
  ["Snowflake", "snowflake"],
  ["dbt", "dbt"],
  ["Pandas", "pandas"],
  ["NumPy", "numpy"],
  ["PyTorch", "pytorch|torch"],
  ["TensorFlow", "tensorflow|keras"],
  ["scikit-learn", "scikit[- ]?learn|sklearn"],
  ["Machine Learning", "machine learning|ml engineer|\\bml\\b"],
  ["LLMs", "llms?|large language models?|genai|generative ai"],
  ["Prisma", "prisma"],
  // Cloud and DevOps
  ["AWS", "aws|amazon web services"],
  ["GCP", "gcp|google cloud"],
  ["Azure", "azure"],
  ["Docker", "docker|containers?"],
  ["Kubernetes", "kubernetes|k8s"],
  ["Terraform", "terraform"],
  ["CI/CD", "ci ?/ ?cd|continuous (?:integration|delivery|deployment)|github actions|jenkins|gitlab ci"],
  ["Linux", "linux|unix"],
  ["Git", "git(?!hub|lab)"],
  ["Nginx", "nginx"],
  ["Serverless", "serverless|lambda"],
  ["Observability", "prometheus|grafana|datadog|observability|opentelemetry"],
  // Testing and other
  ["Jest", "jest"],
  ["Cypress", "cypress"],
  ["Playwright", "playwright"],
  ["Selenium", "selenium"],
  ["Testing", "unit test(?:s|ing)?|test automation|tdd"],
  ["System Design", "system design|distributed systems"],
  ["Data Structures & Algorithms", "data structures|algorithms|dsa"],
];

const MATCHERS = SKILLS.map(([name, pattern]) => ({ name, regex: new RegExp(`(?<![\\w.#+])(?:${pattern})(?![\\w#+])`, "i") }));

/** Every known skill mentioned in the text, in list order. */
export function extractSkills(text: string): string[] {
  if (!text) return [];
  return MATCHERS.filter(({ regex }) => regex.test(text)).map(({ name }) => name);
}

/** All text in a JSON value (resume form data or document), keys left out. */
export function textOf(value: unknown, parts: string[] = []): string[] {
  if (typeof value === "string") parts.push(value);
  else if (Array.isArray(value)) for (const item of value) textOf(item, parts);
  else if (value && typeof value === "object") for (const item of Object.values(value)) textOf(item, parts);
  return parts;
}

export type Match = {
  /** Share of the job's skills found in the resume, 0–100 */
  score: number;
  /** Job skills the resume has */
  matched: string[];
  /** Job skills the resume doesn't mention */
  missing: string[];
};

/** How well a resume's skills cover a job's; null when the post names no known skill. */
export function matchSkills(jobSkills: string[], resumeSkills: Set<string>): Match | null {
  if (jobSkills.length === 0) return null;
  const matched = jobSkills.filter((skill) => resumeSkills.has(skill));
  const missing = jobSkills.filter((skill) => !resumeSkills.has(skill));
  return { score: Math.round((matched.length / jobSkills.length) * 100), matched, missing };
}
