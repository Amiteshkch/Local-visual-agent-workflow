# Equation Network Graph (Flourish-style) — Design

Date: 2026-06-15
Branch: `single-pdf-derivation`
Component: Derivation Workbench, Mathematics tab (`upload.js`, `styles.css`, `upload.html`)

## Goal

Replace the current dagre top-down flow chart in the Mathematics tab with a
**Flourish-style force-directed network graph** of the equations, linked by their
derivation dependencies. Plus two UI cleanups from user feedback:

1. Make the left sidebar (Derivation Workbench panel) **collapsible / hideable**.
2. **Remove the static equation-screenshot photos**; keep the math-method filter
   buttons and **repurpose them to highlight/filter nodes in the network graph**.

### Why
The dagre layout lays 53–168 equation boxes out in pathologically **wide rows**
(McKinley native width 5115px, Yarin 3988px) — at fit-to-width the big papers
collapse into an illegible horizontal smear. A force-directed network packs in 2D,
clusters related equations, and (with compact nodes) scales cleanly to 168+ nodes.

## Research basis (Apify / Flourish network template)

Flourish "Network / Directional graph" = a D3 force simulation:
- Two layers: **Points** (nodes: id, group→colour, numeric size, popup) + **Links**
  (source, target, weight→width).
- Physics layout: "Animate network simulation" + "Repulsion between points";
  nodes are **draggable**, graph settles organically.
- Nodes = circles **coloured by group**, **sized by importance**, hover→name, popups.
- Links curved; **arrows toggle on for directional graphs**; width ∝ weight.

## Reuse — no backend / LLM changes

The existing `/api/eqflow/<id>` output is reused verbatim:
- `p.flow.nodes` = `[{ label:"Eq N", latex }]` (indexed; built from `p.visionEqs`).
- `p.flow.edges` = `[{ from, to, why }]` (integer indices, directed).
- `FLOW_ADJF` / `FLOW_ADJB` adjacency and `flowPathSet(idx)` chain tracing already exist.
- `goToVisionEq(idx)` (click → Vision LaTeX tab) already exists.
- `p.visionEqs[i].page` gives each node's source page (node index ↔ vision eq).
- `equationsFor` shows concept→equation mapping is **page-proximity**: a concept
  `c` has `c.pages`; equations on `c.pages ± 1` belong to it.

Only the **front-end rendering** of the flow changes (`renderFlow` + `layoutFlowDagre`
replaced; `populateFlow`, `buildFlow`, empty states unchanged).

## Change 1 — Force-directed network graph

### Layout
A D3-style force simulation built on the proven `layoutGraph` collision pattern
already used by the cross-PDF knowledge graph (no new CDN dependency; **dagre dropped**):
- Forces: link (springs along edges) + charge/repulsion + collision (no overlap) + center.
- **Directionality preserved two ways**: (a) arrowheads on every edge;
  (b) a gentle **downward y-bias ∝ derivation depth** (topological longest-path rank,
  computed in JS) so sources float to the top and results settle below — reads roughly
  top→down while still packing in 2D.
- Simulation cools to rest (alpha decay) then stops; dragging a node re-heats locally.

### Nodes — hybrid zoom-adaptive (user choice)
SVG circles:
- **Size ∝ degree** (in+out edges) — hub equations are visibly larger.
- **Colour by cluster** = weakly-connected component, each chain a distinct aurora hue.
- **Far zoom**: circle + eq-number text.
- **Past a zoom threshold**: the rendered LaTeX label fades in beneath each node
  (MathJax SVG output, already loaded).
- **Draggable**.

### Edges
Curved SVG paths with arrowheads (derivation direction); `<title>` = `edge.why`.
Uniform subtle width (no weight data).

### Interactions (preserved + upgraded)
- **Hover node** → upstream+downstream chain lights cyan, rest dims (existing
  `flowPathSet`/`highlightFlow`) **+** floating popup with the rendered LaTeX equation.
- **Click node** → `goToVisionEq(idx)` (unchanged).
- **− / fit / +** zoom buttons + **drag-to-pan** retained; **drag a node** to reposition.
- Empty states ("Build flow chart" / "Run a Vision scan first") unchanged.

### Rendering
SVG graph (circles + arrowed curves) inside a CSS-`zoom`/transform wrapper (reuse
existing pan + `applyFlowScale`); zoom-threshold reveals LaTeX labels; one floating
HTML popup for hover (MathJax-rendered). Target 60fps; 168 nodes is well within budget.

## Change 2 — Collapsible left sidebar

- Add a collapse toggle (chevron «) in the sidebar brand/header row.
- Collapsed: `.wb-shell` switches to a sidebar-hidden layout; the main area expands to
  full width; a thin reopen affordance (» button) appears at the left edge.
- State persists in `localStorage` (`wb-sidebar-collapsed`) so it survives reloads.
- CSS transition for the slide; no JS layout thrash.

## Change 3 — Remove equation photos, wire filter to graph

- **Remove** the `.eq-list` equation-screenshot cards (the static crop `<img>`/`<code>`
  cards) from the Mathematics tab.
- **Keep** the math-method filter buttons (`.math-btns`: All equations, Conservation
  laws, Scaling laws, Navier–Stokes, …). Move them to a filter bar above the graph.
- **Wire to graph**: clicking a method computes the node set whose source page ∈
  `concept.pages ± 1` (same page-proximity rule as `equationsFor`) and **highlights
  those nodes (glow) while dimming the rest**, reusing the highlight/dim mechanism.
  "All equations" clears the filter. `mathSel` drives it; hover-trace still works on top.
- The collapsible "Equation screenshots" `<details>` wrapper is removed; the Derivation
  and Concept tabs (which also use `eq-img`) are **unchanged**.

## Files touched

- `upload.js` — rewrite `renderFlow` + `layoutFlowDagre` → force network + node/edge
  render + zoom-adaptive labels + hover popup; add depth-rank + cluster + degree helpers;
  add sidebar-collapse wiring; move `.math-btns` out of `.eq-shots`, drop `.eq-list` in
  the math tab, add filter→graph highlight; keep `populateFlow`/`buildFlow`/empty states.
- `styles.css` — network node/edge/popup/label styles; collapsed-sidebar layout + toggle;
  remove now-unused `.eq-shots`/math-tab `.eq-list` rules (keep eq-img for other tabs).
- `upload.html` — remove the now-unused dagre `<script>`.

## Verification

CDP-screenshot the running server (`:8000`):
- **McKinley (53)** and **Yarin (168)** — confirm the 168-node case is now **legible**
  (the failure case before): visible clusters, directional arrows, degree-sized hubs.
- Hover a node → chain glow + LaTeX popup; zoom in → labels appear; click → Vision tab.
- Toggle sidebar collapse/expand; reload to confirm persistence.
- Click a math-method (e.g. "Scaling laws") → only those nodes glow, rest dim;
  "All equations" clears.
- Confirm the static equation-screenshot photos are gone from the Mathematics tab and
  the Derivation/Concept tabs still render their equation images.

## Out of scope

- Backend / `/api/eqflow` / LLM changes.
- Edge weights (no weight data).
- Changes to Concept, Derivation, or Vision LaTeX tabs beyond the shared-filter source.
