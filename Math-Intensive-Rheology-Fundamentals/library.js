/* library.js — PDF-centric atlas built from window.RHEO_KNOWLEDGE.
   Left: PDFs grouped by sector. Select a paper → Mathematics (math buttons →
   the equations using that math, in derivation sequence) + Concept (objective,
   assumptions, boundary conditions, governing equations) — all extracted from
   the real PDF by tools/extract_knowledge.py. */
(function () {
  "use strict";

  const ZDB_FALLBACK =
    "/Users/amiteshkumar/Library/CloudStorage/GoogleDrive-amitesh18iisc@gmail.com/My Drive/Zotero_DB";

  let K, papersById, conceptById, selectedId = null, mathSel = "all", subTab = "math";

  const esc = (s) =>
    String(s == null ? "" : s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  function pdfHref(paper, page) {
    if (!paper || !paper.file) return null;
    const base = (K && K.zdbPath) || ZDB_FALLBACK;
    const frag = page ? `#page=${page}` : "";
    const full = `${base}/${paper.file}`.split("/").map(encodeURIComponent).join("/");
    return `file://${full}${frag}`;
  }

  const cLabel = (id) => (conceptById[id] ? conceptById[id].label : id);
  const cIcon = (id) => (conceptById[id] ? conceptById[id].icon : "•");

  // equations whose page sits on/next to where a given math concept appears
  function equationsFor(paper, conceptId) {
    if (conceptId === "all") return paper.equations || [];
    const c = (paper.concepts || []).find((x) => x.id === conceptId);
    if (!c || !c.pages || !c.pages.length) return paper.equations || [];
    const near = new Set();
    c.pages.forEach((p) => { near.add(p); near.add(p - 1); near.add(p + 1); });
    const hit = (paper.equations || []).filter((e) => near.has(e.page));
    return hit.length ? hit : paper.equations || [];
  }

  // ── render the selected paper ─────────────────────────────────────────────
  function renderDetail() {
    const host = document.getElementById("paperDetail");
    const p = papersById[selectedId];
    if (!p) return;
    const href = pdfHref(p, p.equations && p.equations[0] ? p.equations[0].page : null);

    const mathButtons =
      `<button class="math-btn${mathSel === "all" ? " active" : ""}" data-math="all">
         <span class="math-ic">∑</span> All equations <em>${(p.equations || []).length}</em></button>` +
      (p.concepts || [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((c) =>
          `<button class="math-btn${mathSel === c.id ? " active" : ""}" data-math="${esc(c.id)}">
             <span class="math-ic">${esc(cIcon(c.id))}</span> ${esc(cLabel(c.id))} <em>${c.count}×</em></button>`)
        .join("");

    const eqs = equationsFor(p, mathSel);
    const eqList = eqs.length
      ? eqs.map((e) => {
          const body = e.img
            ? `<img class="eq-img" src="${esc(e.img)}" alt="${esc(e.text)}" title="${esc(e.text)}" loading="lazy" />`
            : `<code class="eq-text">${esc(e.text)}</code>`;
          return `<li class="eq-item${e.img ? " eq-item--img" : ""}">
             <span class="eq-seq">${e.seq != null ? "Eq " + e.seq : ""}</span>
             ${body}
             <a class="eq-page" href="${esc(pdfHref(p, e.page))}" target="_blank" rel="noopener">p${e.page} ↗</a>
           </li>`;
        }).join("")
      : `<li class="eq-empty">No cleanly-extractable equations found for this selection. Open the PDF to read them.</li>`;

    const sec = p.sections || {};
    const block = (title, items, kind) => {
      const body = (items && items.length)
        ? `<ul class="cc-list cc-${kind}">${items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
        : `<p class="cc-none">Not detected in the first pages — <a href="${esc(href)}" target="_blank" rel="noopener">open the PDF</a> to read it.</p>`;
      return `<section class="cc-block"><h4>${title}</h4>${body}</section>`;
    };

    host.innerHTML = `
      <div class="detail-head">
        <div>
          <span class="sector-chip">${esc(p.sector || "Other")}</span>
          <h2>${esc(p.title)}</h2>
          <p class="detail-meta">${esc(p.authors || "Unknown authors")}${p.year ? " · " + p.year : ""} · ${p.pages} pp · ${(p.concepts || []).length} math methods · ${(p.equations || []).length} equations</p>
        </div>
        ${href ? `<a class="open-pdf" href="${esc(href)}" target="_blank" rel="noopener">Open PDF ↗</a>` : ""}
      </div>

      <div class="sub-tabs">
        <button class="sub-tab${subTab === "math" ? " active" : ""}" data-sub="math">Mathematics</button>
        <button class="sub-tab${subTab === "concept" ? " active" : ""}" data-sub="concept">Concept</button>
      </div>

      <div class="sub-panel" ${subTab === "math" ? "" : "hidden"}>
        <p class="sub-hint">Each button is a kind of mathematics this paper uses — click one to see the equations that use it, in the order they appear in the paper.</p>
        <div class="math-btns">${mathButtons}</div>
        <ol class="eq-list">${eqList}</ol>
      </div>

      <div class="sub-panel" ${subTab === "concept" ? "" : "hidden"}>
        ${block("Objective of the work", sec.objective, "obj")}
        ${block("Assumptions", sec.assumptions, "assum")}
        ${block("Boundary &amp; initial conditions", sec.boundary, "bc")}
        ${block("Governing equations", sec.governing, "gov")}
      </div>`;

    host.querySelectorAll(".math-btn").forEach((b) =>
      b.addEventListener("click", () => { mathSel = b.dataset.math; renderDetail(); }));
    host.querySelectorAll(".sub-tab").forEach((b) =>
      b.addEventListener("click", () => { subTab = b.dataset.sub; renderDetail(); }));
  }

  function selectPaper(id) {
    selectedId = id;
    mathSel = "all";
    document.querySelectorAll(".paper-row").forEach((r) =>
      r.classList.toggle("active", r.dataset.id === id));
    renderDetail();
  }

  // ── sidebar: sectors → papers ─────────────────────────────────────────────
  function renderSectors(filter) {
    const host = document.getElementById("sectorList");
    const q = (filter || "").trim().toLowerCase();
    let html = "";
    (K.sectors || []).forEach((sec) => {
      let rows = sec.paperIds.map((pid) => papersById[pid]).filter(Boolean);
      if (q) {
        rows = rows.filter((p) =>
          p.title.toLowerCase().includes(q) ||
          (p.sector || "").toLowerCase().includes(q) ||
          (p.concepts || []).some((c) => cLabel(c.id).toLowerCase().includes(q)));
      }
      if (!rows.length) return;
      html += `<details class="sector-group" ${q ? "open" : ""}>
        <summary><span>${esc(sec.name)}</span><em>${rows.length}</em></summary>
        <div class="paper-rows">${rows.map((p) =>
          `<button class="paper-row" data-id="${p.id}">
             <strong>${esc(p.title)}</strong>
             <span>${esc(p.authors || "")}${p.year ? " · " + p.year : ""} · ${(p.concepts || []).length} math</span>
           </button>`).join("")}</div>
      </details>`;
    });
    host.innerHTML = html || `<p class="cc-none">No papers match “${esc(q)}”.</p>`;
    host.querySelectorAll(".paper-row").forEach((r) =>
      r.addEventListener("click", () => selectPaper(r.dataset.id)));
    if (selectedId) {
      const cur = host.querySelector(`.paper-row[data-id="${selectedId}"]`);
      if (cur) cur.classList.add("active");
    }
  }

  function init() {
    K = window.RHEO_KNOWLEDGE;
    const stats = document.getElementById("libStats");
    if (!K || !K.papers) {
      if (stats) stats.textContent = "Knowledge base not built — run tools/extract_knowledge.py";
      return;
    }
    papersById = Object.fromEntries(K.papers.map((p) => [p.id, p]));
    conceptById = Object.fromEntries((K.concepts || []).map((c) => [c.id, c]));
    const eqTotal = K.papers.reduce((s, p) => s + (p.equations || []).length, 0);
    if (stats)
      stats.innerHTML =
        `<b>${K.paperCount}</b> papers · <b>${(K.sectors || []).length}</b> sectors · <b>${eqTotal}</b> equations · <b>${(K.concepts || []).filter((c) => c.paperCount).length}</b> math methods`;

    renderSectors("");
    const search = document.getElementById("paperSearch");
    if (search) search.addEventListener("input", () => renderSectors(search.value));

    // open the richest paper so the first impression shows clean, real content
    const score = (p) =>
      (p.mathFont ? 3 : 0) +
      (p.sections && p.sections.objective.length ? 2 : 0) +
      (p.sections && p.sections.governing.length ? 2 : 0) +
      (p.sections && p.sections.boundary.length ? 1 : 0) +
      Math.min(8, (p.equations || []).length) +
      Math.min(6, (p.concepts || []).length);
    const best = K.papers.slice().sort((a, b) => score(b) - score(a))[0];
    if (best) {
      // expand the sector group that contains it
      setTimeout(() => {
        const row = document.querySelector(`.paper-row[data-id="${best.id}"]`);
        const grp = row && row.closest(".sector-group");
        if (grp) grp.setAttribute("open", "");
      }, 0);
      selectPaper(best.id);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
