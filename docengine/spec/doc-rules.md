# CareerPilot docEngine — document JSON rules (schema version 3)

These rules describe the JSON that CareerPilot turns into a PDF (resumes and cover letters): which fields,
tags, attributes and styles a document may use. Every document is checked against them.

**If you are an AI assistant writing a document:**
- Reply with ONLY one JSON object that follows these rules (no explanations, no code fences).
- If the person sends back errors, each has a JSON Pointer `path` (where), a `code` and a `message`: fix them all.
- Never invent experience, employers, dates, numbers, degrees or skills the person did not provide. You may rephrase, reorder, shorten or hide content.
- Keep existing `id`s when editing, so the person can review your changes.

---

## 1. Top level

```json
{
  "schemaVersion": 3,
  "document": "resume",
  "preset": "classic",
  "meta": { "title": "Alex Morgan — Resume", "author": "Alex Morgan", "language": "en" },
  "page": { "size": "A4", "margin": "15mm 16mm", "maxPages": 1, "pageNumbers": true },
  "styles": { "h2": { "text-transform": "uppercase" } },
  "sections": [ { "id": "header", "nodes": [ { "tag": "h1", "text": "Alex Morgan" } ] } ]
}
```

| Field | Required | Rule |
|---|---|---|
| `schemaVersion` | yes | Always `3`. |
| `document` | yes | `"resume"` or `"coverLetter"`. |
| `preset` | no | A ready-made style set: `"classic"` or `"modern"`. Its styles apply first; your `styles` override them. |
| `meta` | no | `title` (≤200), `author` (≤100), `subject` (≤200), `language` (e.g. `"en"`, `"en-IN"`; default `"en"`). Written into the PDF properties. |
| `page` | no | Paper settings (§2). |
| `styles` | no | Global CSS rules (§3). |
| `sections` | yes | 1–50 sections, printed in array order (§4). |

Unknown fields are errors (Auto-fix removes them).

## 2. `page`

| Field | Default | Rule |
|---|---|---|
| `size` | `"A4"` | `"A4"` or `"LETTER"`. |
| `margin` | `"15mm 16mm 16mm 16mm"` | CSS shorthand, 1–4 values (top, right, bottom, left), each 0–40mm. Units: mm (default), cm, in, pt, px. |
| `maxPages` | `10` | 1–10. A document that needs more pages is rejected with `DOCUMENT_TOO_LONG`. |
| `pageNumbers` | `true` | "Page 1 of 2" at the bottom right. |

## 3. `styles` — global CSS

```json
"styles": {
  "body":     { "font-family": "Inter", "font-size": "10pt", "color": "#1f2328" },
  "h2":       { "font-size": "11pt", "border-bottom": "0.75pt solid #c1c7d0" },
  ".muted":   { "color": "#6b6e76" },
  "li.tight": { "margin-bottom": "0" }
}
```

- Selector forms: `body`, a tag (`h2`), a class (`.muted`), or tag + class (`li.tight`).
- Not allowed: combinators (`div p`, `>`, `+`), pseudo-classes (`:hover`), ids, `*`.
- Class names: lower-case letters, digits and `-`, starting with a letter, up to 40 characters.
- At most 100 rules, and 40 properties per rule. Values follow §8.
- Every section is printed as `<section class="section">`, so `.section` styles all sections.

**Cascade (lowest priority first):**
1. Engine defaults
2. `preset` styles
3. `styles` by tag
4. `styles` by class
5. The node's own `style`

A node's `style` always wins, like an inline `style=""` in HTML. Among equal selectors, the later rule wins.

**Engine defaults:**
- body: Inter 10pt, line-height 1.38, colour `#1f2328`
- headings: bold; h1 20pt, h2 12pt, h3 10.5pt
- no margins on headings, paragraphs and lists
- lists indented 13pt
- links: no underline, same colour as the text
- tables: full width, collapsed borders

## 4. `sections`

```json
{ "id": "experience", "title": "Experience", "visible": true, "style": { "margin-top": "12pt" }, "nodes": [ ] }
```

| Field | Rule |
|---|---|
| `id` | Required. `[A-Za-z0-9_-]{1,40}`, unique across the whole document (sections and nodes). |
| `title` | Optional label for editors and change reviews (≤100). **Not printed**: add an `h2` node to print a heading. |
| `visible` | Default `true`. `false` keeps the section in the JSON but leaves it out of the PDF. |
| `style` | CSS for the section's `<section>` element (§8). |
| `nodes` | Up to 200 nodes (§5). |

## 5. Nodes

```json
{ "id": "exp-1", "tag": "p", "class": "muted", "style": { "text-align": "center" }, "text": "plain text" }
```

| Field | Rule |
|---|---|
| `tag` | Required. An allowed tag (§6). |
| `id` | Optional. Same pattern as section ids; unique. Recommended on anything an editor or AI may change. |
| `class` | Optional. Space-separated class names (`"muted tight"`). Using a class that isn't defined in `styles` or the preset gives a warning. |
| `style` | Optional. Inline CSS object (§8). |
| `attrs` | Optional. Tag-specific attributes (§7). |
| `visible` | Optional, default `true`. `false` = not printed. |
| `role`, `data` | Optional meaning tags (§10). They never change how the document looks. |
| **Content** | **At most one** of `text`, `html` or `children`. |

**Content:**
- `text` — plain text, always escaped. Writing `<b>` prints the characters `<b>`. Line breaks (`\n`) become line breaks.
- `html` — a short inline HTML string, e.g. `"Cut latency by <b>40%</b>"`.
  - Allowed tags inside: `b strong i em u s sub sup small mark code span a br`.
  - Allowed attributes inside: only `href` and `title` on `a`.
  - No `style` or `class` inside: styling belongs in the JSON. Use `children` when a part needs styling.
- `children` — an array of nodes, nested at most 12 levels deep.
- `text` and `html` are limited to 5,000 characters per node.

## 6. Tags

| Group | Tags | Content |
|---|---|---|
| Headings | `h1` `h2` `h3` `h4` `h5` `h6` | Inline only |
| Text blocks | `p` `pre` `address` | Inline only (`pre` keeps line breaks) |
| Containers | `div` `section` `header` `footer` `article` `aside` `blockquote` | Blocks and inline |
| Inline | `span` `strong` `b` `em` `i` `u` `s` `small` `mark` `sub` `sup` `code` `abbr` `time` `a` | Inline only (no link inside a link) |
| Lists | `ul` / `ol` → `li`; `dl` → `dt`, `dd` | `ul`/`ol`/`dl` hold only their items; `li` and `dd` hold blocks and inline; `dt` holds inline |
| Tables | `table` → `thead` `tbody` `tfoot` → `tr` → `th` `td` | Strict nesting; `th`/`td` hold blocks and inline |
| Empty | `br` `hr` | No content |

**Placement rules:**
- "Inline only" elements can't contain blocks: no `p` inside `span`, no `div` inside `p`.
- `li`, `dt`/`dd`, `tr`, `th`/`td`, `thead`/`tbody`/`tfoot` must be inside their parent element.

**Never allowed (always an error):** `script`, `style`, `link`, `meta`, `base`, `iframe`, `frame`, `object`, `embed`, `form`, `input`, `button`, `select`, `option`, `textarea`, `svg`, `math`, `img`, `picture`, `video`, `audio`, `source`, `canvas`, `noscript`, `template`, `html`, `head`, `body`, `title`.

Images aren't supported yet.

## 7. Attributes (`attrs`)

| Tag | Attributes |
|---|---|
| `a` | `href` (**required**), `title` |
| `abbr` | `title` |
| `td`, `th` | `colspan`, `rowspan` (1–20) |
| `ol` | `start` (1–1000), `type` (`1` `a` `A` `i` `I`) |
| `time` | `datetime` |
| any tag | `lang` (e.g. `"hi"`) |

Anything else is an error, including:
- `on…` event handlers
- `src`, `srcset`
- `style` (use the `style` field)
- `class` (use the `class` field)
- `id` (use the `id` field)

**Links (`href`):**
- Only `https://`, `http://`, `mailto:` (e.g. `mailto:hr@company.com`) and `tel:` (e.g. `tel:+919876543210`; spaces and dashes are removed).
- A missing scheme gets `https://` added: `github.com/raj` → `https://github.com/raj`.
- `javascript:`, `data:`, `file:` and other schemes are rejected, as are `user:password@` links and links longer than 500 characters.
- Links are only written into the PDF as clickable text; nothing is fetched from them.

```json
{ "tag": "a", "attrs": { "href": "https://github.com/alexmorgan" }, "text": "github.com/alexmorgan" }
```

## 8. CSS (`style` and `styles`)

Values are strings: `{ "font-size": "11pt" }`.

| Category | Properties |
|---|---|
| Text | `font-family`, `font-size`, `font-weight`, `font-style`, `color`, `line-height`, `text-align`, `text-decoration`, `text-transform`, `text-indent`, `white-space`, `word-break`, `word-wrap`, `vertical-align` |
| Box | `margin`, `margin-top/right/bottom/left`, `padding`, `padding-top/right/bottom/left`, `width`, `min-width`, `max-width`, `height`, `min-height`, `max-height` |
| Borders | `border`, `border-top/right/bottom/left`, `border(-side)-width`, `border(-side)-style`, `border(-side)-color`, `border-radius`, `border-collapse`, `border-spacing` |
| Background | `background-color` |
| Layout | `display` (`block` `inline` `inline-block` `table` `table-row` `table-cell` `list-item` `none`), `float`, `clear`, `list-style-type`, `list-style-position` |
| Pages | `page-break-before`, `page-break-after`, `page-break-inside`, `orphans`, `widows`, `-fs-page-break-min-height` (keep at least this much space before a heading breaks to the next page) |

**Values:**

- **Lengths:** `pt`, `mm`, `cm`, `in`, `px`, `em`, `%`. Unitless only for `0`.
- **Number ranges:**
  - `font-size`: 6–40pt, or 0.5–4em, or 50–400%
  - `margin`: −20 to 50mm
  - `padding`: 0–50mm
  - widths and heights: 0–300mm or 0–100%
  - border width: up to 3mm
  - `border-radius`: up to 20mm
  - `line-height`: 0.8–3 (or a length)
  - `text-indent`: −50 to 50mm
- **Colours:** `#rgb`, `#rrggbb`, `rgb(r, g, b)`, or a basic name: `black`, `white`, `gray`/`grey`, `dimgray`, `darkgray`, `lightgray`, `silver`, `red`, `darkred`, `maroon`, `orange`, `yellow`, `olive`, `green`, `darkgreen`, `teal`, `navy`, `blue`, `darkblue`, `purple`, `brown`, `transparent`. Text with contrast below 4.5:1 against its background gives a warning.
- **Fonts:** only bundled families (§9), or the generic names `sans-serif` (→ Inter) and `serif` (→ Source Serif 4).
- **Blocked values:** `url(...)` anywhere, `!important`, comments, backslashes, and the characters `; { } < > @`.
- **Blocked properties, with the reason in the error:** `position`, `transform`, `filter`, `opacity`, `z-index`, `background`, `background-image`, `content`, `letter-spacing`, `word-spacing` (both break PDF text extraction for ATS), `font` (use the individual properties), `list-style-image`, `cursor`, `columns` / `column-count` / `column-gap` (multi-column layout isn't supported: use a table with one cell per column), `overflow-wrap` (use `word-wrap`).
- **Not supported by the PDF engine:** `display: flex` and `display: grid` give `CSS_LAYOUT_UNSUPPORTED`. Use a table, or `float` / `display: table-cell`, for side-by-side layout.

**Two columns side by side:**
```json
{ "tag": "div", "style": { "display": "table", "width": "100%" }, "children": [
  { "tag": "div", "style": { "display": "table-cell", "width": "65%" }, "text": "Left" },
  { "tag": "div", "style": { "display": "table-cell", "padding-left": "6mm" }, "text": "Right" }
]}
```

**Title left, dates right:**
```json
{ "tag": "p", "children": [
  { "tag": "strong", "text": "Software Engineer" },
  { "tag": "span", "style": { "float": "right" }, "text": "2025 – Present" }
]}
```

## 9. Fonts

| Family | Kind | Weights |
|---|---|---|
| `Inter` | sans-serif (default) | 400, 400 italic, 600, 700 |
| `Source Serif 4` | serif | 400, 400 italic, 600, 700 |

Fonts are embedded in every PDF, so text stays selectable and readable by applicant tracking systems (ATS). Other fonts aren't available yet; asking for one gives `CSS_FONT_UNAVAILABLE` with the list.

## 10. Meaning tags: `role` and `data`

These are optional, but recommended for resumes. They don't change how the document looks. They let CareerPilot understand the content: compare versions, check that an AI didn't invent experience, and fill in emails.

- **`role`** — one of: `name`, `headline`, `contact`, `section-title`, `summary`, `entry`, `entry-title`, `organization`, `date`, `bullet`, `skill-group`, `link`, `letter-recipient`, `letter-date`, `letter-subject`, `letter-salutation`, `letter-body`, `letter-closing`, `signature`.
- **`data`** — a flat object, at most 20 fields.
  - Names: letters and digits.
  - Values: text up to 300 characters, numbers, `true`/`false` or `null`.
  - `start` and `end` must be `YYYY` or `YYYY-MM`; `end: null` means "present".

```json
{ "tag": "div", "role": "entry",
  "data": { "kind": "job", "title": "Software Engineer", "org": "Acme Corp", "start": "2025-01", "end": null },
  "children": [ ] }
```

## 11. Limits

| Item | Limit |
|---|---|
| Document size | 512 KB of JSON |
| Sections | 50 |
| Nodes in the document | 2,000 |
| Children per element / nodes per section | 200 |
| Nesting depth | 12 |
| `text` / `html` per node | 5,000 characters |
| Style rules / properties per style | 100 / 40 |
| Pages | `page.maxPages` (at most 10) |

## 12. Checking a document

Every document is checked against all of these rules before it becomes a PDF.

- **Check**: any broken rule is an error, listed with its JSON Pointer `path`, a `code` and a `message`, e.g.
  `/sections/1/nodes/0/style/display` · `CSS_LAYOUT_UNSUPPORTED` · "display: flex isn't supported in PDF output; use a table or float for side-by-side layout."
- **Auto-fix**: repairs what it can and lists each change:
  - unknown fields are removed
  - unknown tags become `div`/`span`; nodes without a `tag` are removed
  - disallowed tags and their content are removed
  - invalid CSS declarations are dropped
  - unsafe links become plain text
  - long text is cut
  - missing ids are generated
- **Notes** (warnings) don't block the PDF: an undefined class, or low text contrast.
- A valid document that needs more pages than `page.maxPages` is rejected (`DOCUMENT_TOO_LONG`).

**Error codes:**

| Area | Codes |
|---|---|
| Document structure | `NOT_AN_OBJECT`, `SCHEMA_VERSION`, `DOCUMENT_KIND`, `PRESET_UNKNOWN`, `UNKNOWN_FIELD`, `WRONG_TYPE`, `MISSING_SECTIONS` |
| Ids and text | `ID_MISSING`, `ID_INVALID`, `ID_DUPLICATE`, `TEXT_TOO_LONG` |
| Limits | `TOO_MANY_SECTIONS`, `TOO_MANY_NODES`, `TOO_MANY_CHILDREN`, `TOO_DEEP`, `TOO_MANY_STYLES`, `TOO_MANY_DECLARATIONS` |
| Tags and content | `TAG_MISSING`, `TAG_UNKNOWN`, `TAG_BLOCKED`, `TAG_WRONG_PARENT`, `TAG_WRONG_CHILD`, `BLOCK_IN_INLINE`, `LINK_IN_LINK`, `CONTENT_CONFLICT`, `CONTENT_NOT_ALLOWED` |
| Inline `html` | `INLINE_TAG_NOT_ALLOWED`, `INLINE_ATTR_NOT_ALLOWED` |
| Attributes and links | `ATTR_NOT_ALLOWED`, `ATTR_BLOCKED`, `ATTR_INVALID`, `UNSAFE_LINK`, `LINK_MISSING_HREF` |
| Classes and selectors | `CLASS_INVALID`, `SELECTOR_INVALID` |
| CSS | `CSS_PROPERTY_UNKNOWN`, `CSS_PROPERTY_BLOCKED`, `CSS_VALUE_INVALID`, `CSS_VALUE_BLOCKED`, `CSS_FONT_UNAVAILABLE`, `CSS_LAYOUT_UNSUPPORTED` |
| Page and meta | `PAGE_SIZE`, `PAGE_MARGIN`, `MAX_PAGES`, `LANGUAGE_INVALID` |
| Meaning tags | `ROLE_UNKNOWN`, `DATA_INVALID`, `DATA_DATE_FORMAT` |
| Warnings | `CLASS_UNDEFINED`, `LOW_CONTRAST` |
| Creating the PDF | `DOCUMENT_TOO_LONG` (more pages than `maxPages`), `DOCUMENT_TOO_LARGE` |

## 13. Complete example: a one-page resume

```json
{
  "schemaVersion": 3,
  "document": "resume",
  "preset": "classic",
  "meta": { "title": "Alex Morgan — Resume", "author": "Alex Morgan", "language": "en" },
  "page": { "size": "A4", "margin": "14mm 16mm", "maxPages": 1 },
  "styles": {
    ".date": { "float": "right", "color": "#44474f" }
  },
  "sections": [
    { "id": "header", "style": { "margin-top": "0" }, "nodes": [
      { "tag": "h1", "class": "name header", "role": "name", "text": "Alex Morgan" },
      { "tag": "p", "class": "headline header", "role": "headline", "text": "Software Engineer | Full Stack Developer" },
      { "tag": "p", "class": "contact header", "role": "contact", "children": [
        { "tag": "a", "class": "contact-link", "attrs": { "href": "mailto:alex@example.com" }, "text": "alex@example.com" },
        { "tag": "span", "class": "sep", "text": " | " },
        { "tag": "a", "class": "contact-link", "attrs": { "href": "https://github.com/alexmorgan" }, "text": "github.com/alexmorgan" }
      ]}
    ]},
    { "id": "summary", "nodes": [
      { "tag": "h2", "class": "section-title", "role": "section-title", "text": "Summary" },
      { "tag": "p", "class": "summary first", "role": "summary",
        "html": "Full-stack engineer building <b>React</b>, <b>Next.js</b> and <b>Spring Boot</b> apps." }
    ]},
    { "id": "experience", "nodes": [
      { "tag": "h2", "class": "section-title", "role": "section-title", "text": "Experience" },
      { "id": "exp-koshine", "tag": "div", "class": "entry first", "role": "entry",
        "data": { "kind": "job", "title": "Software Engineer", "org": "Acme Corp", "start": "2025-01", "end": null },
        "children": [
          { "tag": "p", "children": [
            { "tag": "strong", "text": "Software Engineer" },
            { "tag": "span", "text": " — Acme Corp" },
            { "tag": "span", "class": "date", "text": "2025 – Present" }
          ]},
          { "tag": "ul", "class": "entry-highlights", "children": [
            { "tag": "li", "role": "bullet", "text": "Built a customer messaging platform used by 2,000 teams." },
            { "tag": "li", "role": "bullet", "html": "Cut API latency by <b>40%</b> with Redis caching." }
          ]}
        ]}
    ]},
    { "id": "skills", "nodes": [
      { "tag": "h2", "class": "section-title", "role": "section-title", "text": "Skills" },
      { "tag": "p", "class": "skill first", "role": "skill-group", "children": [
        { "tag": "span", "class": "skill-name", "text": "Languages: " },
        { "tag": "span", "text": "Java, TypeScript, Python, SQL" }
      ]}
    ]}
  ]
}
```

**Classes the presets define:**
- **Header:** `header`, `name`, `headline`, `contact`, `contact-link`, `sep`
- **Sections:** `section-title`, `summary`, `first` (extra space after a section title)
- **Entries:** `entry`, `entry-head` (a table row holding `entry-main` and `entry-dates`), `entry-title`, `entry-link`, `entry-subtitle`, `entry-description`, `entry-highlights`
- **Lists and skills:** `list-items`, `skill`, `skill-name`

## 14. Cover letter

Use the same document format with `"document": "coverLetter"`. Example:

```json
{
  "schemaVersion": 3,
  "document": "coverLetter",
  "preset": "classic",
  "meta": { "title": "Alex Morgan — Cover letter", "author": "Alex Morgan" },
  "page": { "maxPages": 1, "pageNumbers": false },
  "sections": [
    { "id": "letter", "style": { "margin-top": "0" }, "nodes": [
      { "tag": "p", "role": "letter-date", "text": "12 October 2026" },
      { "tag": "address", "role": "letter-recipient", "style": { "margin-top": "6mm" }, "text": "Hiring Manager\nAcme Corp" },
      { "tag": "p", "role": "letter-subject", "style": { "margin-top": "6mm", "font-weight": "700" }, "text": "Application: Backend Engineer" },
      { "tag": "p", "role": "letter-salutation", "style": { "margin-top": "4mm" }, "text": "Dear Hiring Manager," },
      { "tag": "p", "role": "letter-body", "style": { "margin-top": "3mm" }, "text": "…" },
      { "tag": "p", "role": "letter-closing", "style": { "margin-top": "6mm" }, "text": "Kind regards,\nAlex Morgan" }
    ]}
  ]
}
```
