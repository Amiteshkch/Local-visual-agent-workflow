# Math Extraction Display Model

When a paper or book PDF is added to `Zotero_DB`, the portal should not show it as a flat citation. It should be converted into an explorable mathematical map.

## Target Display

1. Source document
   - title, authors, year, DOI, local PDF path
   - book chapter or paper section outline
   - extraction confidence and missing OCR warnings

2. Equation cards
   - canonical equation in rendered MathJax
   - nearby definitions of symbols
   - assumptions and boundary conditions
   - source location: page, section, figure, paragraph
   - dependency links to earlier equations
   - downstream links to observables such as relaxation time, modulus, viscosity, diffusivity, radius, stress, or force

3. Beginner layer
   - physical interpretation in plain language
   - vector-level diagram or animation
   - minimal prerequisites
   - "why this term appears" notes

4. GraphRAG layer
   - typed nodes: Concept, Assumption, Equation, Observable, Source, Model, Regime
   - typed edges: derives, assumes, measures, scales-as, approximates, evidenced-by
   - local retrieval: neighborhood around one equation or concept
   - global retrieval: community map across Rouse, Zimm, tube theory, extensional rheology, and linear viscoelasticity

5. Missing PDF queue
   - if a core paper is known but not local, the Atlas lists it as `pdf-needed`
   - once the PDF is placed in `Zotero_DB`, rerun `node tools/build-library-index.mjs`

## Current Prototype State

The current implementation already has the display slots:

- `Derive`: curated equation ladder for a topic
- `Vector`: bead, connector, end-to-end vector, contour length, and radius-of-gyration visualization
- `Atlas`: Zotero-derived source coverage and missing PDF queue
- `Graph`: GraphRAG-style evidence map with local/global modes
- `Compare`: regime-level comparison

The next implementation step is full equation extraction from PDFs. For scanned PDFs this requires OCR; for text PDFs, `pdftotext` can seed the first extraction pass, but robust equation capture will need a math-aware parser.
