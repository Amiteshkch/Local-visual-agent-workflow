# Chapter-scoped Ingestion for Large (Scanned) Books — Design

Date: 2026-06-16
Branch: `single-pdf-derivation`
Components: `server.py`, `tools/extract_knowledge.py`, `upload.js`, `styles.css`

## Goal

Let the workbench handle **large books** (hundreds of pages, often fully scanned) by
working **one to a few chapters at a time** instead of the whole file:

1. **Detect chapters** from the book and present them in an editable dropdown/table
   (number · name · page range).
2. Let the user **select 1–3 chapters** within a page budget.
3. **Vision-scan only those chapters** (background job) to transcribe their equations.
4. Build a **relational knowledge graph** of those equations, grouped by chapter, showing
   dependencies **within** and **between** chapters.

### Why (the failure this fixes)

The workbench was built for single papers (tens of pages). On a 670-page scanned book
(Bird *Dynamics of Polymeric Liquids* Vol. 1) it fails because:
- `extract_pdf(..., max_pages=300)` — a hard 300-page cap; nothing past it is seen.
- The file is **image-only (no text layer)**, so the text equation-detector finds nothing
  and the server falls back to **OCR'ing the entire book** (`ocrmypdf --force-ocr`), which
  is designed for short excerpts and effectively stalls on a whole 51 MB book.
- **Vision LaTeX** (the route that works on scans) is **manual, page-range, ~25 s/page** —
  impractical to hand-drive across 670 pages.
- No chapter awareness; this PDF also has **0 embedded bookmarks** (verified).

## Locked design decisions

- **Chapter detection:** vision-read the Contents page → parse chapters → **show an editable
  table for the user to confirm/fix** before scanning (handles TOC/offset misreads).
- **Scan bound:** **~60-page budget** per selection (tunable); over-budget selections warn
  and offer to trim. The scan runs as a **background job with a live progress bar**.
- **Relations:** the scan has no prose text layer, so equation relations come from **reading
  the mathematics** — the existing symbolic `eqflow` links equation B→A when B reuses A's
  quantities/symbols. This holds within and across chapters.

## Architecture & components

### 1. Chapter detection — `POST /api/detect-chapters/<pid>` (server.py)
- Render the front pages (≈ first 25) at moderate DPI; locate the **Contents** page(s)
  (the vision model is asked "is this a table of contents?" / look for a "Contents" heading).
- Vision model (format=json) returns `[{num, name, printed_start}]`.
- **Offset calibration:** take one chapter's `printed_start`, render PDF pages around the
  naive guess (`printed_start + estimatedOffset`), and confirm the chapter heading via vision;
  derive `offset = pdfPage − printed_start`. Apply to all chapters.
- Compute `pdfStart = printed_start + offset`, `pdfEnd = nextChapter.pdfStart − 1`
  (last chapter → book end).
- Persist `chapters: [{num, name, printedStart, pdfStart, pdfEnd}]` into `paper.json`.
- **Fallback:** if no TOC is found or parse fails, return `{needsManual: true}` so the UI
  shows an empty editable table for manual ranges.

### 2. Chapter panel (upload.js + styles.css)
- When `DATA.paper.chapters` exists, render a **chapter table** above `#flowChart`:
  multi-select rows (checkbox · `Ch N · name` · editable `start–end` · page count).
- Running total of selected pages; if `> BUDGET (60)` show a warning with trim affordances
  (uncheck a chapter, or edit a range). "Scan selected" disabled until within budget OR the
  user confirms an over-budget scan.
- "Scan selected ▸" → POST the chosen ranges to start the background job; poll for progress.

### 3. Chapter-scoped Vision scan — background job (server.py)
- `POST /api/vision-scan/<pid>` `{ranges:[[s,e],…], model}` → starts a background worker
  (Python thread + an in-memory job registry), returns `{jobId}`.
- `GET /api/vision-job/<jobId>` → `{status, done, total, eqs}` for the progress bar.
- The worker reuses the existing per-page vision transcription (as in `/api/vision-page`)
  over the selected pages — **vision reads the rendered page image directly, so no OCR and
  no 300-page cap apply**. Each equation is tagged `{chapter, page, latex, label}` and
  appended to `paper.visionEqs` (persisted). Idempotent per page (re-scan replaces).

### 4. Cross-chapter knowledge graph (upload.js, Mathematics tab)
- After a scan, call the existing `POST /api/eqflow/<pid>` (symbolic, shared-quantity
  dependencies) over the scanned equations and render the existing force-directed network
  (`layoutNetwork`/`renderFlow`).
- **Color/group nodes by chapter** (replace the depth-gradient `nodeColor` input with the
  node's `chapter` when chapters exist; keep depth gradient for single-paper mode).
- **Cross-chapter edges** (endpoints in different chapters) get a distinct style so
  between-chapter relations stand out from within-chapter ones.
- A small chapter legend (color → chapter name).

## Data model additions (`paper.json`)
```jsonc
"chapters": [ { "num": 4, "name": "The Generalized Newtonian Fluid",
               "printedStart": 169, "pdfStart": 188, "pdfEnd": 273 }, … ],
"visionEqs": [ { "seq": 1, "page": 190, "latex": "…", "label": "…", "chapter": 4 }, … ]
```

## API summary
| Method & path | Purpose |
|---|---|
| `POST /api/detect-chapters/<pid>` | Vision-parse the TOC → chapter list w/ PDF ranges (editable). |
| `POST /api/vision-scan/<pid>` | Start a background vision scan of the given page ranges. |
| `GET  /api/vision-job/<jobId>` | Poll scan progress + partial results. |
| `POST /api/eqflow/<pid>` | (existing) build the dependency graph over scanned equations. |

## Data flow
upload big PDF → `detect-chapters` → user edits/selects chapters (≤ budget) →
`vision-scan` (background, progress) → equations tagged by chapter → `eqflow` →
network graph **colored by chapter**, cross-chapter links highlighted.

## Error handling
- No TOC / parse failure → manual range table (`needsManual`).
- Offset miscalibration → user edits ranges before scanning (the confirm step).
- Over budget → warn + trim; explicit confirm required to exceed.
- Vision model missing → actionable error (`ollama pull qwen2.5vl:7b`).
- Background job error/timeout on a page → record per-page failure, continue, allow retry.

## Files touched
- `server.py` — `detect-chapters`, `vision-scan` (+ job registry), `vision-job` endpoints;
  big-scanned uploads skip whole-book OCR and defer to chapter detection.
- `tools/extract_knowledge.py` — TOC-page detection + chapter parse helpers; reuse the
  page-render + vision-call helpers already used by `/api/vision-page`.
- `upload.js` — chapter table UI + selection/budget logic; background-scan polling;
  chapter coloring + cross-chapter edge styling in `renderFlow`/`nodeColor`.
- `styles.css` — chapter table, progress bar, chapter legend, cross-chapter edge style.

## Verification
- On the Bird book: `detect-chapters` returns ~10 chapters with names matching the TOC and
  plausible PDF ranges (Ch 4 ≈ PDF 188). Editing a range works.
- Select a small chapter (e.g. Ch 5, ~28 pp) within budget → background scan completes with
  progress → equations transcribed and tagged `chapter:5`.
- Select two chapters → network graph shows two color groups with cross-chapter links
  highlighted; CDP screenshot verifies legibility and grouping.
- Over-budget selection shows the warning/trim path.

## Out of scope / YAGNI
- No whole-book OCR or whole-book scanning.
- No prose-narrative relation extraction (relations are math/shared-symbol based).
- No change to single-paper mode (chapters absent → existing behavior, depth-gradient color).

## Phasing
1. Chapter detection + editable table + background chapter-scoped vision scan.
2. Chapter-colored cross-chapter graph + legend.
Sequential (the graph needs scanned equations); one spec.
