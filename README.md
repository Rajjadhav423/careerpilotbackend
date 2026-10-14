# CareerPilot API

The backend for CareerPilot, a job-search assistant. It provides a REST API for:

- **Job tracking:** a board of saved jobs with statuses (Saved → Applied → Interview → Offer …)
- **Job discovery:** open tech roles from public company job boards (Greenhouse, Lever, Ashby)
- **Email templates and applications:** templates with merge fields, sent from the user's own Gmail
- **Resumes:** a resume editor format, templates, live preview, PDF download and version history
- **Documents:** JSON documents validated against a fixed rule set and rendered to PDF or page images
- **Google Drive:** saving generated PDFs to a CareerPilot folder in the user's Drive

Sign-in is handled by [Clerk](https://clerk.com). Every endpoint except health and the Clerk webhook needs a Clerk session token.

## Tech stack

- Node.js 20+, TypeScript, Express 5
- PostgreSQL with Prisma
- Zod for request validation
- @react-pdf/renderer for PDFs (pure JavaScript, no browser)
- Vitest and Supertest for tests

## Getting started

### 1. Install

```bash
npm install
```

This also generates the Prisma client.

### 2. Configure

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. On Neon, use the pooled string with `&pgbouncer=true` added. |
| `DIRECT_URL` | Direct (non-pooled) connection string, used for migrations. Locally it can match `DATABASE_URL`. |
| `CLERK_ISSUER` | Your Clerk Frontend API URL, e.g. `https://xxxx.clerk.accounts.dev` |
| `CLERK_AUTHORIZED_PARTIES` | Frontend origins allowed to request tokens (comma-separated) |
| `CLERK_SECRET_KEY` | Clerk secret key. Needed for Gmail sending and Google Drive. |
| `CLERK_WEBHOOK_SECRET` | Signing secret of the Clerk webhook. If empty, webhooks are disabled. |
| `CORS_ALLOWED_ORIGINS` | Frontend origins allowed to call the API (comma-separated) |
| `RESUME_VERSIONS_ENABLED` | `true` to keep resume history and suggestions |

`.env.example` also lists the optional PDF limits and the job board list. Never commit `.env`.

### 3. Set up the database

On a new, empty database:

```bash
npm run migrate
```

If the tables already exist, mark the initial migration as applied instead:

```bash
npx prisma migrate resolve --applied 0_init
```

### 4. Run

```bash
npm run dev      # development, reloads on change (http://localhost:8080)
npm run build    # compile to dist/
npm start        # run the compiled build
```

Check that it's up: `GET http://localhost:8080/api/v1/health`

## Deploying to Vercel

Vercel runs `src/app.ts` as a serverless function (`vercel.json` adds the `docengine/` fonts and presets to it).

1. Set the environment variables from `.env.example` in the Vercel project (Neon: pooled `DATABASE_URL` with
   `&pgbouncer=true`, direct `DIRECT_URL`).
2. Run migrations from your machine against the production database: `npm run migrate`.
3. Point the Clerk webhook to `https://<your-app>.vercel.app/api/v1/webhooks/clerk`.

## Tests

```bash
npm test
```

- Unit tests and HTTP tests run without a database or network access; outside services are faked.
- Database tests run when `TEST_DATABASE_URL` is set. Use an **empty database you can wipe**, because the tests empty every table.
- PDF tests print real PDFs (no browser needed).

Type-check with `npm run typecheck`.

## Project structure

```
src/
  create-app.ts     routes and middleware
  server.ts         entry point for local and long-running hosts (listens on PORT)
  app.ts            entry point for serverless hosts like Vercel (default-exports the app)
  config.ts         environment settings
  auth/             Clerk tokens and webhook
  users/  jobs/  templates/  applications/  gmail/
  discovery/        job boards and the tech-role classifier
  resumes/          resume format, conversion, diffs, routes
  docengine/        document rules, HTML writer, PDF writer
  drive/            Google Drive
  http/             errors and validation helpers
prisma/             schema and migrations
docengine/          bundled fonts, style presets, resume JSON schema, document rules
test/               unit, HTTP, database and PDF tests
```

## API overview

All routes are under `/api/v1`.

| Area | Routes |
| --- | --- |
| Health and user | `GET /health`, `GET /me`, `POST /webhooks/clerk` |
| Saved details | `GET/PUT /me/fields`: reusable values used in resumes and documents as `{{key}}` |
| Jobs | `GET/POST /jobs`, `GET/PATCH /jobs/:id` |
| Application emails | `POST /jobs/:id/emails/compose`, `GET/POST /jobs/:id/emails` |
| Email templates | `/email-templates`, `/email-templates/merge-fields`, `/email-templates/preview` |
| Gmail | `GET /gmail/status` |
| Discovery | `GET /discover/jobs?q=&location=&role=` |
| Resumes | `/resumes`, `/resumes/:id/versions`, `/resumes/render/{preview,pdf,pages,drive}` (`pages` returns the PDF as base64 for in-browser preview) |
| Documents | `GET /docs/rules`, `GET /docs/presets`, `POST /docs/validate`, `POST /docs/render/{pdf,pages,html}` |
| Google Drive | `/drive/status`, `/drive/connect`, `/drive/folders`, `/drive/documents` |

Errors use one JSON shape: `{ "title", "status", "detail", "code", "errors"? }`.
