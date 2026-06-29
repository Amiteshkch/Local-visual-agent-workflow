# ReadLines_Maths — Derivation Workbench

Turn **math-heavy / physics PDFs (papers, books, scanned excerpts)** into an interactive,
machine-readable view of *their actual mathematics*: every display equation detected and
cropped true-to-print, transcribed to LaTeX with a vision model, linked into a
**derivation-dependency graph**, with a local LLM reconstructing the algebra between any
two equations. A persistent multi-PDF library and a cross-PDF "knowledge graph" of shared
mathematical concepts sit on top.

It is a **single-file-per-layer static front-end + a small Flask backend**, no build step.

> **Heads-up for agents/LLMs working on this repo:** the current, live application is the
> **`single-pdf-derivation`** branch (the branch name is historical — it is now a full
> *multi-PDF persistent* workbench). Start there. See **[How to work on this repo](#how-to-work-on-this-repo-for-llm-agents)**
> and **[Current state & roadmap](#current-state--roadmap)** below before editing.

---

## What it does (end to end)

1. **Drop a PDF** in the left sidebar (or pick one already in the library).
2. The backend extracts, per paper: the **sector** (domain), the **math methods used**
   (29-concept lexicon, with the pages each appears on), the **equations** in order
   (cropped to true-to-print PNG images), and **Objective / Assumptions / Boundary /
   Governing** sentences from the text.
3. **Mathematics tab** — the equations drawn as a **force-directed network graph**
   (ResearchRabbit-style, light canvas): hollow circles sized by how many equations they
   connect to, coloured by derivation depth, linked by their *derivation dependencies*
   (not just page order). Hover a node → its direct connections light blue + a LaTeX popup;
   click → jump to its Vision LaTeX; drag/zoom/pan. Above it, a **highlight-by-method**
   filter (only methods actually detected in the paper) dims non-matching nodes.
4. **Concept tab** — Objective / Assumptions / Boundary conditions / Governing equations,
   plus "References from the web" (via the Firecrawl CLI, if authenticated).
5. **Vision LaTeX tab** — reads each *rendered page* with a vision model and transcribes
   equations to LaTeX. Works on **scanned** PDFs and text PDFs with broken/subset math
   fonts, where plain text extraction fails. These clean equations feed the network graph.
   **Explain step** asks a local LLM to reconstruct the algebra between two equations
   (MathJax-rendered), and you can **drill into** any intermediate step recursively.
7. **Knowledge graph** (across PDFs) — a force-directed graph of which mathematical
   concepts are shared across the papers in your library.

Everything persists: each upload is saved under `uploads/library/<sha1>/` and reloads on
restart.

---

## Quick start

```bash
pip install flask                 # only hard dependency for the server
python3 server.py                 # → http://127.0.0.1:8000  then drop a PDF
```

Optional, enabling more features:

- **Ollama** (local, free, no API key) — powers "explain step" and Vision LaTeX.
  Default text model `qwen2.5-coder:7b`; a vision-capable model is auto-detected
  (`ollama pull qwen2.5vl:7b` for a local one).
- **ocrmypdf + tesseract** (`brew install ocrmypdf tesseract`) — only truly-scanned PDFs
  (no text layer) are auto-OCR'd; equation crops come from the real page image regardless.
- **Firecrawl CLI** (`npm i -g firecrawl`, then `firecrawl login --browser`) — enables the
  "References from the web" panel. Degrades gracefully when not authenticated.

The multi-PDF persistent workbench is the app served at `/`. (There is also a separate
static *whole-Zotero-library atlas* on the `multi-pdf-atlas` branch — see [Branches](#branches).)

---

## Architecture & file map

```
server.py                 Flask API (:8000). Imports tools/extract_knowledge.py — NO duplicated logic.
tools/extract_knowledge.py  All extraction: equation detection, cropping/rendering, concept
                          classification, section regexes, symbolic eq-flow builder. Runnable as a CLI.
upload.html               Front-end shell for the workbench (loads MathJax, GSAP, dagre, upload.js).
upload.js                 The workbench front-end (IIFE). Library sidebar, the 4 tabs, flow chart,
                          vision scan, derivation drill-down, cross-PDF graph. ~1.4k lines.
styles.css                Token-driven aurora-glass theme + all component styles.
index.html + library.js   The static "Library Atlas" UI (mainly used on multi-pdf-atlas).
data/knowledge.json|.js   Pre-extracted whole-library knowledge (atlas).
uploads/library/<id>/     Per-PDF persisted workspace (gitignored). See data model below.
docs/                     math-extraction-display.md + superpowers/specs/ design specs.
```

**Backend ↔ frontend contract:** the front-end never duplicates extraction logic; it calls
the API, renders the JSON, and persists nothing itself.

---

## Data model — `uploads/library/<id>/paper.json`

`<id>` = first 12 hex of the PDF's sha1. Folder also holds `source.pdf` (or
`source_ocr.pdf`) and an `eq/` dir of cropped equation PNGs.

```jsonc
{
  "id": "2eda1646e5d0",
  "title": "McKinley - 2005 - Visco-elasto-capillary thinning…",
  "sector": "Capillary breakup & pinch-off",      // 1 of 8 domains
  "pages": 50,
  "scanned": false,
  "concepts": [ { "id": "scaling", "count": 8, "pages": [3,4,9] }, … ],  // math methods
  "equations": [ { "seq": 1, "page": 4, "text": "…", "img": "/api/eqimg/<id>/1.png" }, … ],
  "sections": { "objective": [...], "assumptions": [...], "boundary": [...], "governing": [...] },
  "visionEqs": [ { "seq": 1, "page": 4, "latex": "We = \\rho V^2 R/\\sigma", "label": "Eq 1" }, … ],
  "flow": {                                         // derivation-dependency graph
    "nodes": [ { "label": "Eq 1", "latex": "…" }, … ],
    "edges": [ { "from": 0, "to": 3, "why": "Wi uses ρR³/τ from Eq 1" }, … ],
    "src":   "symbolic"
  }
}
```

`concepts[].pages` is how a math method maps to equations: equations whose `page` is within
±1 of any of a concept's `pages` belong to that method (see `equationsFor` in `upload.js`).

---

## API reference (`server.py`)

| Method & path | Purpose |
|---|---|
| `GET  /` | Serves the workbench (`upload.html`). |
| `POST /api/extract` | Extract one freshly-uploaded PDF → persists to `uploads/library/<id>/`. |
| `GET  /api/library` | List the persisted library + concept metadata. |
| `GET  /api/library/<id>` | Load one paper (re-derives page text for derivation context). |
| `DELETE /api/library/<id>` | Remove a paper from the library. |
| `GET  /api/pdf/<id>` | Serve the stored PDF (`#page=N` works in-browser). |
| `GET  /api/eqimg/<id>/<file>` | Serve a cropped equation PNG. |
| `GET  /api/graph` | Cross-PDF concept graph (which concepts appear in which PDFs). |
| `POST /api/eqflow/<id>` | Build/return the derivation-dependency flow (deterministic, symbolic; cached in paper.json). |
| `GET  /api/models` / `GET /api/vision-models` | List available Ollama text / vision models. |
| `POST /api/vision-page` | Transcribe one rendered page's equations to LaTeX with a vision model. |
| `POST /api/explain-step` | LLM reconstructs the algebra between two equations. |
| `POST /api/explain-substep` | LLM justifies/derives one intermediate step (recursive drill-down). |
| `POST /api/web-references` | Web references via the Firecrawl CLI (handles unauthenticated gracefully). |

---

## LLM & vision provider configuration

Provider-agnostic via env vars; defaults to **local Ollama (no API key)**.

| Provider | Env | Notes |
|---|---|---|
| `ollama` (default) | `LLM_MODEL=qwen2.5-coder:7b` | local, free; pick any pulled model in the UI dropdown. |
| `openrouter` | `LLM_PROVIDER=openrouter LLM_MODEL=… OPENROUTER_API_KEY=…` | free-tier key; larger models. |
| `anthropic` | `LLM_PROVIDER=anthropic LLM_MODEL=claude-… ANTHROPIC_API_KEY=…` | paid API. |
| vision | `VISION_MODEL=…` | else auto-detected from Ollama (any model whose capabilities include `vision`). |

A claude.ai Pro/Max subscription is a web product and **cannot** be called as an API.

---

## How to work on this repo (for LLM agents)

- **Edit the front-end in `upload.js` + `styles.css`.** `upload.js` is a single **IIFE**, so
  `DATA`, `visionEqs`, etc. are closure-scoped and **not** reachable from the console /
  CDP `Runtime.evaluate('DATA')` — query the **DOM** instead when inspecting state.
- **No build step.** Edit, reload `http://127.0.0.1:8000`. Restart `server.py` for backend changes.
- **Extraction logic lives only in `tools/extract_knowledge.py`** — the server imports it;
  don't duplicate it in `server.py`.
- **Verify visually with a real screenshot**, not just by reading code. Launch headless
  Chrome with `--remote-debugging-port=9222 --remote-allow-origins='*'` and drive it over
  CDP (navigate to `:8000`, click `.lib-pick[data-id="…"]` to load a paper, then screenshot).
  Big papers (e.g. 168 equations) are the cases that break layouts — always test one.
- **Design specs** for in-progress work live in `docs/superpowers/specs/`. Read the latest
  before changing the relevant component.
- Uploaded PDFs, equation crops (`uploads/`, `data/eq/`) and `__pycache__` are gitignored.

---

## Branches

- **`single-pdf-derivation`** — **the current live app** (this is where active work happens):
  the multi-PDF persistent Derivation Workbench described above.
- **`multi-pdf-atlas`** — a static whole-library "atlas": `index.html` + `library.js` reading
  a pre-extracted `data/knowledge.json` of an entire Zotero library (no per-PDF upload).
- **`main`** — the older pre-atlas seed.

---

## Current state & roadmap

**Done** (commit `85b8819`; spec at `docs/superpowers/specs/2026-06-15-equation-network-graph-design.md`):
the Mathematics tab is a **force-directed network graph** (light, ResearchRabbit-style) that
replaced the old dagre layout — which became an illegible very-wide smear on large papers.
It packs in 2D and stays legible at 220 equations: hollow degree-sized circles, depth-gradient
colour, `Eq N` labels, 1-hop blue selection on hover + LaTeX popup, drag/zoom/pan. The
highlight-by-method filter shows **only methods actually detected** (find_concepts now requires
≥2 mentions and uses tighter lexicons). The left sidebar is collapsible (persisted). The
Derivation tab was removed (explain-step lives in the Vision LaTeX tab).

Layout lives in `layoutNetwork`/`renderFlow` in `upload.js`; node/edge styling under the
`.flow-inner.net` rules in `styles.css`. Reuses the `/api/eqflow` output unchanged.

Longer-term: editable LaTeX for *text* PDFs via Mathpix/Nougat; let the user link any two
equations for "explain step" rather than assuming consecutive equations form a chain; an
optional graph-viz library (Sigma.js / Cytoscape.js) if node counts grow — see the
`knowledge-graph-resources` skill.

---

## Reference seeds (polymer dynamics / rheology)

- Rouse 1953 https://doi.org/10.1063/1.1699180 · Zimm 1956 https://doi.org/10.1063/1.1742462
- Doi & Edwards 1978 https://doi.org/10.1039/F29787401789 · McLeish 2002 https://doi.org/10.1080/00018730210153216
- Rubinstein & Colby, *Polymer Physics*, OUP 2003 · Likhtman & McLeish 2002 https://doi.org/10.1021/ma0200219
- Dinic et al. 2015 https://doi.org/10.1021/acsmacrolett.5b00393 · Del Giudice et al. 2017 https://doi.org/10.1122/1.4975933
- Bird, Armstrong & Hassager, *Dynamics of Polymeric Liquids* · de Gennes 1974 · Entov & Hinch 1997
