/* upload.js — single-PDF workbench front-end.
   Uploads a PDF to /api/extract (server.py runs the same extraction pipeline),
   then shows the equations (true-to-PDF crops) in derivation sequence, the math
   the paper uses, and the objective / assumptions / boundary / governing text. */
(function () {
  "use strict";

  let DATA = null, conceptById = {}, mathSel = "all", subTab = "math";
  let MODELS = [], selectedModel = "";
  let VMODELS = [], VVISION = [], visionModel = "", visionEqs = [], visionBusy = false, visionStop = false;
  let flowScale = 1, flowW = 0, FLOW_ADJF = [], FLOW_ADJB = [];
  let derivationExports = [];

  const esc = (s) =>
    String(s == null ? "" : s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  // minimal markdown → HTML (keeps LaTeX intact for MathJax)
  function mdToHtml(t) {
    const blocks = esc(t)
      .replace(/^\s*#{1,6}\s*(.+)$/gm, '<strong class="gap-h">$1</strong>')
      .split(/\n{2,}/).map((b) => {
      b = b.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
           .replace(/`([^`]+)`/g, "<code>$1</code>");
      if (/^\s*(\d+\.|[-*])\s/.test(b)) {
        const ol = /^\s*\d+\./.test(b);
        const items = b.split(/\n(?=\s*(?:\d+\.|[-*])\s)/)
          .map((li) => "<li>" + li.replace(/^\s*(?:\d+\.|[-*])\s/, "") + "</li>").join("");
        return `<${ol ? "ol" : "ul"}>${items}</${ol ? "ol" : "ul"}>`;
      }
      return "<p>" + b.replace(/\n/g, "<br>") + "</p>";
    });
    return blocks.join("");
  }

  const cLabel = (id) => (conceptById[id] ? conceptById[id].label : id);
  const cIcon = (id) => (conceptById[id] ? conceptById[id].icon : "•");

  function equationsFor(p, conceptId) {
    if (conceptId === "all") return p.equations || [];
    const c = (p.concepts || []).find((x) => x.id === conceptId);
    if (!c || !c.pages || !c.pages.length) return p.equations || [];
    const near = new Set();
    c.pages.forEach((pg) => { near.add(pg); near.add(pg - 1); near.add(pg + 1); });
    const hit = (p.equations || []).filter((e) => near.has(e.page));
    return hit.length ? hit : p.equations || [];
  }

  const pdfPageHref = (page) =>
    (DATA && DATA.paper && DATA.paper.id) ? `/api/pdf/${DATA.paper.id}#page=${page}` : "#";

  function showResult() {
    document.getElementById("graphView").hidden = true;
    document.getElementById("upResult").hidden = false;
    document.getElementById("graphBtn").classList.remove("active");
  }
  function showGraphView() {
    document.getElementById("upResult").hidden = true;
    document.getElementById("graphView").hidden = false;
    document.getElementById("graphBtn").classList.add("active");
  }
  const setStatus = (html) => { document.getElementById("upStatus").innerHTML = html; };

  // ── upload handling ───────────────────────────────────────────────────────
  function wireDropzone() {
    const dz = document.getElementById("dropzone");
    const input = document.getElementById("pdfInput");
    input.addEventListener("change", () => { if (input.files[0]) { upload(input.files[0]); input.value = ""; } });
    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
    dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) upload(f); });
  }

  function adoptData(j) {
    DATA = j;
    conceptById = j.concepts || conceptById;
    selectedModel = selectedModel || (j.llm && j.llm.model) || "";   // reconciled against installed models in fetchModels
    if (j.vision && j.vision.model) visionModel = visionModel || j.vision.model;
    mathSel = "all"; subTab = "math"; visionBusy = false;
    derivationExports = [];
    visionEqs = ((j.paper && j.paper.visionEqs) || []).map((e, i) =>
      ({ seq: i + 1, page: e.page, latex: e.latex, label: e.label }));   // restore saved vision LaTeX
  }

  async function upload(file) {
    setStatus(`<div class="up-busy"><span class="spinner spinner-sm"></span> Reading “${esc(file.name)}”…</div>`);
    try {
      const fd = new FormData(); fd.append("pdf", file);
      const r = await fetch("/api/extract", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Extraction failed.");
      adoptData(j);
      setStatus(`<div class="up-ok">✓ added “${esc(file.name)}”</div>`);
      await loadLibrary();
      showResult(); renderResult();
    } catch (err) {
      setStatus(`<div class="up-err">${esc(err.message)}</div>`);
    }
  }

  // ── library (left sidebar) ─────────────────────────────────────────────────
  async function loadLibrary() {
    try {
      const j = await (await fetch("/api/library")).json();
      conceptById = j.concepts || conceptById;
      renderLibList(j.papers || [], j.groups || []);
    } catch (e) { /* ignore */ }
  }

  const grpCollapsed = (n) => { try { return localStorage.getItem("wb-grp:" + n) === "1"; } catch (e) { return false; } };
  const setGrpCollapsed = (n, v) => { try { localStorage.setItem("wb-grp:" + n, v ? "1" : "0"); } catch (e) {} };

  function renderLibList(papers, groups) {
    const host = document.getElementById("libList");
    const curId = DATA && DATA.paper && DATA.paper.id;
    const byGroup = {}; const ungrouped = [];
    papers.forEach((p) => { const g = (p.group || "").trim(); if (g) (byGroup[g] = byGroup[g] || []).push(p); else ungrouped.push(p); });
    const names = (groups || []).slice();
    Object.keys(byGroup).forEach((g) => { if (!names.includes(g)) names.push(g); });   // groups on papers but missing from the index

    const newGroupRow = `<div class="lib-newgrp-row"><input id="libNewGroup" class="lib-grp-input" placeholder="＋ new group…" /></div>`;
    if (!papers.length && !names.length) {
      host.innerHTML = newGroupRow + `<p class="lib-empty">No PDFs yet — add one above.</p>`;
      wireNewGroup(host); return;
    }

    const optList = (sel) => [`<option value=""${!sel ? " selected" : ""}>— Ungrouped —</option>`]
      .concat(names.map((g) => `<option${g === sel ? " selected" : ""}>${esc(g)}</option>`)).join("");
    const paperHtml = (p) => `
      <div class="lib-item${p.id === curId ? " active" : ""}" data-id="${p.id}">
        <button class="lib-pick" data-id="${p.id}">
          <strong>${esc((p.title || "").replace(/\.pdf$/i, ""))}</strong>
          <span>${p.scanned ? "scanned · " : ""}${p.nEq} eq${p.nVision ? " · " + p.nVision + " vis" : ""} · ${p.nConcepts} math</span>
        </button>
        <select class="lib-grp-sel" data-id="${p.id}" title="move to group">${optList(p.group || "")}</select>
        <button class="lib-del" data-del="${p.id}" title="remove from library">×</button>
      </div>`;
    const section = (name, items, editable) => {
      const col = grpCollapsed(name);
      return `<div class="lib-group${col ? " collapsed" : ""}" data-group="${esc(name)}">
        <div class="lib-grp-head">
          <button class="lib-grp-toggle" data-group="${esc(name)}"><span class="caret">▾</span><span class="lib-grp-name">${esc(name)}</span><em>${items.length}</em></button>
          ${editable ? `<button class="lib-grp-ren" data-group="${esc(name)}" title="rename group">✎</button><button class="lib-grp-del" data-group="${esc(name)}" title="delete group">×</button>` : ""}
        </div>
        <div class="lib-grp-body">${items.map(paperHtml).join("") || `<p class="lib-empty-grp">empty — move a PDF here with its group menu</p>`}</div>
      </div>`;
    };

    let html = newGroupRow;
    names.forEach((g) => { html += section(g, byGroup[g] || [], true); });
    if (ungrouped.length || !names.length) html += section("Ungrouped", ungrouped, false);
    host.innerHTML = html;

    host.querySelectorAll(".lib-pick").forEach((b) => b.addEventListener("click", () => selectLibraryPaper(b.dataset.id)));
    host.querySelectorAll(".lib-del").forEach((d) => d.addEventListener("click", () => deletePaper(d.dataset.del)));
    host.querySelectorAll(".lib-grp-sel").forEach((s) => s.addEventListener("change", () => assignGroup(s.dataset.id, s.value)));
    host.querySelectorAll(".lib-grp-toggle").forEach((b) => b.addEventListener("click", () => {
      const sec = b.closest(".lib-group"); const willCollapse = !sec.classList.contains("collapsed");
      sec.classList.toggle("collapsed", willCollapse); setGrpCollapsed(b.dataset.group, willCollapse);
    }));
    host.querySelectorAll(".lib-grp-ren").forEach((b) => b.addEventListener("click", () => renameGroupInline(b)));
    host.querySelectorAll(".lib-grp-del").forEach((b) => b.addEventListener("click", () => manageGroup("delete", b.dataset.group)));
    wireNewGroup(host);
  }

  function wireNewGroup(host) {
    const inp = host.querySelector("#libNewGroup");
    if (inp) inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const v = inp.value.trim(); if (v) manageGroup("create", v); }
    });
  }

  function renameGroupInline(btn) {
    const name = btn.dataset.group;
    const nameEl = btn.closest(".lib-grp-head").querySelector(".lib-grp-name");
    if (!nameEl) return;
    const inp = document.createElement("input");
    inp.className = "lib-grp-input"; inp.value = name;
    nameEl.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      if (save && v && v !== name) manageGroup("rename", name, v); else loadLibrary();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
    inp.addEventListener("blur", () => finish(true));
  }

  async function assignGroup(id, group) {
    await fetch("/api/library/" + id + "/group", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group }) });
    loadLibrary();
  }
  async function manageGroup(action, name, newName) {
    await fetch("/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, name, newName }) });
    loadLibrary();
  }

  async function selectLibraryPaper(id) {
    setStatus(`<div class="up-busy"><span class="spinner spinner-sm"></span> Loading…</div>`);
    try {
      const j = await (await fetch("/api/library/" + id)).json();
      if (j.error) throw new Error(j.error);
      adoptData(j);
      setStatus("");
      document.querySelectorAll(".lib-item").forEach((b) =>
        b.classList.toggle("active", b.dataset.id === id));
      showResult(); renderResult();
    } catch (e) { setStatus(`<div class="up-err">${esc(e.message)}</div>`); }
  }

  async function deletePaper(id) {
    await fetch("/api/library/" + id, { method: "DELETE" });
    if (DATA && DATA.paper && DATA.paper.id === id) {
      DATA = null;
      document.getElementById("upResult").innerHTML =
        `<div class="detail-empty">Pick a PDF from the left, or add one.</div>`;
    }
    loadLibrary();
  }

  // ── results ───────────────────────────────────────────────────────────────
  function renderResult() {
    hideTopicPanel();                    // drop any open topic panel on re-render / tab switch
    const host = document.getElementById("upResult");
    host.hidden = false;
    const p = DATA.paper;
    const eqCount = (p.equations || []).length;
    const imgCount = (p.equations || []).filter((e) => e.img).length;

    const mathButtons =
      `<button class="math-btn${mathSel === "all" ? " active" : ""}" data-math="all">
         <span class="math-ic">∑</span> All equations <em>${eqCount}</em></button>` +
      (p.concepts || []).slice().sort((a, b) => b.count - a.count).map((c) =>
        `<button class="math-btn${mathSel === c.id ? " active" : ""}" data-math="${esc(c.id)}">
           <span class="math-ic">${esc(cIcon(c.id))}</span> ${esc(cLabel(c.id))} <em>${c.count}×</em></button>`).join("");

    const eqs = equationsFor(p, mathSel);
    const eqList = eqs.length
      ? eqs.map((e) => {
          const body = e.img
            ? `<img class="eq-img" src="${esc(e.img)}" alt="${esc(e.text)}" title="${esc(e.text)}" loading="lazy" />`
            : `<code class="eq-text">${esc(e.text)}</code>`;
          return `<li class="eq-item${e.img ? " eq-item--img" : ""}">
             <span class="eq-seq">${e.seq != null ? "Eq " + e.seq : ""}</span>
             ${body}
             <a class="eq-page" href="${pdfPageHref(e.page)}" target="_blank" rel="noopener">p${e.page} ↗</a>
           </li>`;
        }).join("")
      : `<li class="eq-empty">No cleanly-detectable display equations for this selection.</li>`;

    const sec = p.sections || {};
    const block = (title, items, kind) =>
      `<section class="cc-block"><h4>${title}</h4>${
        (items && items.length)
          ? `<ul class="cc-list cc-${kind}">${items.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
          : `<p class="cc-none">Not detected in the text layer of this PDF.</p>`}</section>`;

    host.innerHTML = `
      <div class="detail-head">
        <div>
          <span class="sector-chip">${esc(p.sector || "Other")}</span>
          <h2>${esc(p.title)}</h2>
          <p class="detail-meta">${p.pages} pages · ${(p.concepts || []).length} math methods · ${eqCount} equations (${imgCount} rendered as printed)</p>
        </div>
        <div class="detail-actions">
          <button class="open-pdf" id="notebookLmBtn">NotebookLM source</button>
        </div>
      </div>
      <div id="notebookLmStatus" class="notebooklm-status"></div>
      <details class="obsidian-panel">
        <summary>Export to Obsidian</summary>
        <div class="obsidian-grid">
          <div class="obsidian-field">
            <span>vault path</span>
            <div class="obsidian-vault-picker">
              <input id="obsVaultPath" list="obsVaultOptions" type="text" placeholder="/Users/you/Documents/Obsidian Vault" value="${esc(localStorage.getItem("wb-obs-vault") || "")}" />
              <datalist id="obsVaultOptions">${obsVaults().map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>
              <select id="obsVaultSelect" title="saved vault paths">
                <option value="">Saved vaults</option>
                ${obsVaults().map((v) => `<option value="${esc(v)}">${esc(v.split(/[\\/]/).filter(Boolean).pop() || v)}</option>`).join("")}
              </select>
              <button type="button" class="obsidian-folder-btn" id="obsChooseVault" title="choose a folder if your browser supports it">Choose folder</button>
            </div>
          </div>
          <label>project folder
            <input id="obsFolder" type="text" value="Derivation Workbench/${esc((p.title || "Paper").replace(/\.pdf$/i, ""))}" />
          </label>
          <label>eq from
            <input id="obsEqFrom" type="number" min="1" value="1" />
          </label>
          <label>eq to
            <input id="obsEqTo" type="number" min="1" value="${Math.max(1, visionEqs.length || eqCount || 1)}" />
          </label>
          <label class="obsidian-check">
            <input id="obsCreateVault" type="checkbox" /> create vault folder if missing
          </label>
        </div>
        <div class="obsidian-actions">
          <button class="open-pdf alt" data-obs-export="graph">Graph</button>
          <button class="open-pdf alt" data-obs-export="vision">Vision LaTeX</button>
          <button class="open-pdf alt" data-obs-export="equations">Selected equations</button>
          <button class="open-pdf alt" data-obs-export="explanations">Explanation steps</button>
          <button class="open-pdf" data-obs-export="bundle">Bundle</button>
        </div>
        <div id="obsidianStatus" class="obsidian-status"></div>
      </details>

      <div class="sub-tabs">
        <button class="sub-tab${subTab === "math" ? " active" : ""}" data-sub="math">Mathematics</button>
        <button class="sub-tab${subTab === "concept" ? " active" : ""}" data-sub="concept">Concept</button>
        <button class="sub-tab${subTab === "vision" ? " active" : ""}" data-sub="vision">Vision LaTeX</button>
      </div>

      <div class="sub-panel" ${subTab === "math" ? "" : "hidden"}>
        <div class="flow-head">
          <p class="sub-hint">Equations as a <b>derivation network</b> — linked by their dependencies (from the mathematics &amp; text, not just order). Hover a node to trace its chain; click it to open its <b>Vision LaTeX</b>; drag to rearrange.</p>
          <button class="open-pdf" id="buildFlowBtn">${(p.flow && p.flow.nodes && p.flow.nodes.length) ? "Rebuild flow" : "Build flow chart"}</button>
        </div>
        <div class="math-filter"><span class="mf-label">highlight by method:</span><div class="math-btns">${mathButtons}</div>${
          (p.concepts || []).length === 0
            ? `<button class="detect-methods" id="detectMethods" title="${visionEqs.length ? "classify the math methods from the read equations" : "scan the PDF in the Vision LaTeX tab first"}">✨ detect methods from equations</button>`
            : ""}</div>
        <div id="flowChart" class="flow-chart"></div>
      </div>

      <div class="sub-panel" ${subTab === "concept" ? "" : "hidden"}>
        ${block("Objective of the work", sec.objective, "obj")}
        ${block("Assumptions", sec.assumptions, "assum")}
        ${block("Boundary &amp; initial conditions", sec.boundary, "bc")}
        ${block("Governing equations", sec.governing, "gov")}
        <section class="cc-block">
          <h4>References from the web · Firecrawl</h4>
          <div class="webref-bar">
            <input id="webrefQuery" type="text" value="${esc((p.title || "").replace(/\.pdf$/i, ""))}" placeholder="topic, paper, or concept to look up" />
            <button class="open-pdf" id="webrefBtn">Find references</button>
          </div>
          <div id="webrefResults" class="webref-results"></div>
        </section>
      </div>

      <div class="sub-panel" ${subTab === "vision" ? "" : "hidden"}>
        <div class="derive-bar">
          <p class="sub-hint">Reads each page with a <b>vision model</b> and transcribes its equations to LaTeX — works on <b>scanned &amp; broken-font</b> PDFs where text extraction fails.${
            (DATA && DATA.vision && DATA.vision.available)
              ? "" : " <b style='color:#ff8aa6'>No vision model found</b> — run <code>ollama pull qwen2.5vl:7b</code>."}</p>
          <div class="vision-ctrl">
            <label class="model-pick">vision
              <select id="visionSel" title="pick any model to transcribe with — try a different one if results are poor">${
                (VMODELS.length ? VMODELS : [visionModel]).filter(Boolean).map((m) =>
                  `<option value="${esc(m)}"${m === visionModel ? " selected" : ""}>${esc(m)}${(VVISION.length && !VVISION.includes(m)) ? " · no vision" : ""}</option>`).join("")
              }</select></label>
            <label class="model-pick">pages
              <input id="vpFrom" type="number" min="1" value="1" />–
              <input id="vpTo" type="number" min="1" value="${Math.min(p.pages || 1, 12)}" /></label>
            <button class="open-pdf" id="visionRun">${visionBusy ? "Stop" : "Scan"}</button>
            <button class="open-pdf alt" id="visionFixBroken" title="re-read every equation that failed to render">↻ retry broken</button>
          </div>
        </div>
        <div id="visionProgress" class="vision-progress"></div>
        <ol class="eq-list" id="visionList">${
          visionEqs.map((it, i) => visionItemHtml(it, i, visionEqs.length)).join("")}</ol>
      </div>`;

    host.querySelectorAll(".math-btn").forEach((b) =>
      b.addEventListener("click", () => {
        mathSel = b.dataset.math;
        host.querySelectorAll(".math-btn").forEach((x) => x.classList.toggle("active", x.dataset.math === mathSel));
        applyFlowFilter();   // highlight matching nodes in the network (no full re-render)
        if (mathSel === "all") hideTopicPanel();   // a specific method → explain it + show references
        else showTopicPanel(mathSel);
      }));
    const dmb = host.querySelector("#detectMethods");
    if (dmb) dmb.addEventListener("click", detectMethods);
    host.querySelectorAll(".sub-tab").forEach((b) =>
      b.addEventListener("click", () => { subTab = b.dataset.sub; renderResult(); }));
    const ms = host.querySelector("#modelSel");
    if (ms) ms.addEventListener("change", () => { selectedModel = ms.value; });
    host.querySelectorAll(".gap-btn:not(.vbtn)").forEach((b) =>
      b.addEventListener("click", () => explainStep(parseInt(b.dataset.from, 10), b)));
    const vrun = host.querySelector("#visionRun");
    if (vrun) vrun.addEventListener("click", runVisionScan);
    wireVisionList(host.querySelector("#visionList"));
    const vfb = host.querySelector("#visionFixBroken");
    if (vfb) vfb.addEventListener("click", retryAllBrokenVisionEqs);
    const wrb = host.querySelector("#webrefBtn");
    if (wrb) wrb.addEventListener("click", fetchWebRefs);
    const nlb = host.querySelector("#notebookLmBtn");
    if (nlb) nlb.addEventListener("click", exportNotebookLmSource);
    const op = host.querySelector(".obsidian-panel");
    if (op) op.addEventListener("click", (e) => {
      if (e.target && e.target.id === "obsChooseVault") chooseObsidianVault();
    });
    const ovs = host.querySelector("#obsVaultSelect");
    if (ovs) ovs.addEventListener("change", () => {
      const inp = host.querySelector("#obsVaultPath");
      if (ovs.value && inp) inp.value = ovs.value;
    });
    loadObsidianVaultCandidates();
    host.querySelectorAll("[data-obs-export]").forEach((b) =>
      b.addEventListener("click", () => exportObsidian(b.dataset.obsExport, b)));
    const bfb = host.querySelector("#buildFlowBtn");
    if (bfb) bfb.addEventListener("click", () =>
      buildFlow(!!(DATA.paper.flow && DATA.paper.flow.nodes && DATA.paper.flow.nodes.length)));
    if (subTab === "math") populateFlow();
    if (subTab === "vision" && visionEqs.length) typesetVision();
  }

  async function exportNotebookLmSource() {
    const btn = document.getElementById("notebookLmBtn");
    const box = document.getElementById("notebookLmStatus");
    if (!DATA || !DATA.paper || !DATA.paper.id || !btn || !box) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Exporting...";
    box.innerHTML = `<div class="up-busy"><span class="spinner spinner-sm"></span> Building NotebookLM Markdown source...</div>`;
    try {
      const r = await fetch("/api/notebooklm-export/" + DATA.paper.id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webRefs: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "NotebookLM export failed.");
      box.innerHTML = `<div class="up-ok notebooklm-ok">
        Saved <code>${esc(j.filename)}</code> in <code>notebooklm_exports</code>.
        <a href="${esc(j.downloadUrl)}">Download Markdown</a>
      </div>`;
    } catch (err) {
      box.innerHTML = `<div class="up-err">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  const mdEsc = (s) => String(s == null ? "" : s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const mdTitle = () => ((DATA && DATA.paper && DATA.paper.title) || "Derivation Workbench").replace(/\.pdf$/i, "");
  const obsVaults = () => {
    try {
      const saved = JSON.parse(localStorage.getItem("wb-obs-vaults") || "[]");
      const last = localStorage.getItem("wb-obs-vault") || "";
      return [last, ...saved].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);
    } catch (e) { return []; }
  };
  const saveObsVault = (vault) => {
    if (!vault) return;
    try {
      const next = [vault, ...obsVaults().filter((v) => v !== vault)].slice(0, 8);
      localStorage.setItem("wb-obs-vault", vault);
      localStorage.setItem("wb-obs-vaults", JSON.stringify(next));
    } catch (e) {}
  };
  function refreshObsVaultSelect() {
    const sel = document.getElementById("obsVaultSelect");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">Saved vaults</option>` +
      obsVaults().map((v) => `<option value="${esc(v)}">${esc(v.split(/[\\/]/).filter(Boolean).pop() || v)}</option>`).join("");
    sel.value = cur;
  }
  const obsRange = () => {
    const from = Math.max(1, parseInt(document.getElementById("obsEqFrom")?.value, 10) || 1);
    const to = Math.max(from, parseInt(document.getElementById("obsEqTo")?.value, 10) || from);
    return { from, to };
  };
  const inRange = (seq, range) => seq >= range.from && seq <= range.to;
  const shortNode = (s) => mdEsc(s).replace(/\s+/g, " ").replaceAll('"', "'").slice(0, 76);
  const xmlEsc = (s) => String(s == null ? "" : s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  function graphSvgAsset() {
    const flow = DATA.paper.flow || {};
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    if (!nodes.length || !NET || !NET.pos || !NET.radius) return null;
    const width = Math.max(900, Math.ceil(Math.max(...NET.pos.map((p, i) => p.x + (NET.radius[i] || 20))) + 80));
    const height = Math.max(520, Math.ceil(Math.max(...NET.pos.map((p, i) => p.y + (NET.radius[i] || 20))) + 80));
    const paths = edges.filter((e) => e.from !== e.to).map((e) => {
      const d = netEdgePath(e.from, e.to);
      return `<path d="${xmlEsc(d)}" fill="none" stroke="#64748b" stroke-width="1.4" marker-end="url(#arrow)"><title>${xmlEsc(e.why || "")}</title></path>`;
    }).join("\n");
    const dots = nodes.map((n, i) => {
      const p = NET.pos[i], r = NET.radius[i] || 18;
      const label = shortNode(n.label || ("Eq " + (i + 1)));
      return `<g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="#eef2ff" stroke="#6366f1" stroke-width="1.8"/>
        <text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-family="Inter, Arial, sans-serif" fill="#111827">${xmlEsc("Eq " + (i + 1))}</text>
        <text x="${p.x.toFixed(1)}" y="${(p.y + r + 14).toFixed(1)}" text-anchor="middle" font-size="9" font-family="Inter, Arial, sans-serif" fill="#475569">${xmlEsc(label)}</text>
      </g>`;
    }).join("\n");
    return {
      filename: "derivation-graph.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/></marker></defs>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="24" y="32" font-size="18" font-weight="700" font-family="Inter, Arial, sans-serif" fill="#111827">${xmlEsc(mdTitle())}</text>
  <g transform="translate(0,44)">${paths}\n${dots}</g>
</svg>`
    };
  }

  function obsidianGraphMd() {
    const flow = DATA.paper.flow || {};
    const nodes = flow.nodes || [];
    const edges = flow.edges || [];
    if (!nodes.length || !edges.length) return "No derivation graph has been built yet.";
    const lines = ["![[assets/derivation-graph.svg]]", "", "```mermaid", "graph TD"];
    nodes.forEach((n, i) => lines.push(`  E${i + 1}["${shortNode(n.label || ("Eq " + (i + 1)))}"]`));
    edges.forEach((e) => {
      if (e.from === e.to) return;
      lines.push(`  E${e.from + 1} -->|${shortNode(e.why || "depends")}| E${e.to + 1}`);
    });
    lines.push("```");
    return lines.join("\n");
  }

  function obsidianVisionMd(range) {
    const chosen = visionEqs.filter((e, i) => inRange(e.seq || i + 1, range));
    if (!chosen.length) return "No Vision LaTeX equations are available for this range.";
    return chosen.map((e, i) => `## ${mdEsc(e.label || ("Eq " + (e.seq || i + 1)))} | page ${e.page || "?"}\n\n$$\n${mdEsc(e.latex)}\n$$`).join("\n\n");
  }

  function obsidianEquationsMd(range) {
    const eqs = ((DATA.paper && DATA.paper.equations) || []).filter((e) => inRange(e.seq || 0, range));
    if (!eqs.length) return "No extracted text-layer equations are available for this range.";
    return eqs.map((e) => `## Eq ${e.seq} | page ${e.page || "?"}\n\n${mdEsc(e.text) || "_No text captured._"}`).join("\n\n");
  }

  function obsidianExplanationsMd(range) {
    const hits = derivationExports.filter((d) => {
      const a = d.fromSeq || 0, b = d.toSeq || a;
      return (a >= range.from && a <= range.to) || (b >= range.from && b <= range.to);
    });
    if (!hits.length) return "No explanation steps have been generated in this page session for the selected range. Click an `explain step` button first, then export again.";
    return hits.map((d) => `## ${mdEsc(d.label)}\n\n${mdEsc(d.explanation)}`).join("\n\n");
  }

  function buildObsidianNote(kind) {
    const range = obsRange();
    const title = mdTitle();
    const head = `# ${title}\n\n- Workbench paper id: \`${DATA.paper.id}\`\n- Export type: ${kind}\n- Equation range: ${range.from}-${range.to}\n- Source: Derivation Workbench\n`;
    const sections = [];
    if (kind === "graph" || kind === "bundle") sections.push(["Derivation Graph", obsidianGraphMd()]);
    if (kind === "vision" || kind === "bundle") sections.push(["Vision LaTeX", obsidianVisionMd(range)]);
    if (kind === "equations" || kind === "bundle") sections.push(["Selected Extracted Equations", obsidianEquationsMd(range)]);
    if (kind === "explanations" || kind === "bundle") sections.push(["Generated Explanation Steps", obsidianExplanationsMd(range)]);
    return head + "\n" + sections.map(([h, body]) => `# ${h}\n\n${body}`).join("\n\n");
  }

  async function chooseObsidianVault() {
    const status = document.getElementById("obsidianStatus");
    const input = document.getElementById("obsVaultPath");
    if (!input) return;
    status.innerHTML = `<div class="up-busy"><span class="spinner spinner-sm"></span> Opening folder picker...</div>`;
    try {
      const r = await fetch("/api/obsidian/choose-vault", { method: "POST" });
      const j = await r.json();
      if (r.ok && j.path) {
        input.value = j.path;
        saveObsVault(j.path);
        refreshObsVaultSelect();
        status.innerHTML = `<div class="up-ok">Selected vault: <code>${esc(j.path)}</code></div>`;
        return;
      }
      throw new Error(j.error || "Native folder picker unavailable.");
    } catch (serverErr) {
      status.innerHTML = `<div class="up-err">${esc(serverErr.message)} Paste the vault path manually, or choose from Saved vaults.</div>`;
    }
    if (!window.showDirectoryPicker) {
      input.focus();
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      const picked = dir.name || "";
      if (picked && !input.value.trim()) input.value = picked;
      status.innerHTML = `<div class="up-err">Browser folder picker selected “${esc(picked)}”, but it does not expose the full local path to this Flask server. Paste the full vault path once; it will be saved in the dropdown.</div>`;
      input.focus();
    } catch (e) {
      status.innerHTML = `<div class="cc-none">Folder selection cancelled.</div>`;
    }
  }

  async function loadObsidianVaultCandidates() {
    try {
      const r = await fetch("/api/obsidian/vaults");
      const j = await r.json();
      (j.vaults || []).forEach(saveObsVault);
      refreshObsVaultSelect();
      const input = document.getElementById("obsVaultPath");
      if (input && !input.value && obsVaults()[0]) input.value = obsVaults()[0];
    } catch (e) {}
  }

  async function exportObsidian(kind, btn) {
    const status = document.getElementById("obsidianStatus");
    const vault = (document.getElementById("obsVaultPath")?.value || "").trim();
    const folder = (document.getElementById("obsFolder")?.value || "").trim();
    const createVault = !!document.getElementById("obsCreateVault")?.checked;
    if (!vault) { status.innerHTML = `<div class="up-err">Paste an Obsidian vault folder path first.</div>`; return; }
    saveObsVault(vault);
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "Exporting...";
    status.innerHTML = `<div class="up-busy"><span class="spinner spinner-sm"></span> Writing ${esc(kind)} note into Obsidian vault...</div>`;
    try {
      const title = `${mdTitle()} - ${kind}`;
      const assets = [];
      if (kind === "graph" || kind === "bundle") {
        const graphAsset = graphSvgAsset();
        if (graphAsset) assets.push(graphAsset);
      }
      const r = await fetch("/api/obsidian/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultPath: vault, folder, title, createVault, markdown: buildObsidianNote(kind), assets }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Obsidian export failed.");
      status.innerHTML = `<div class="up-ok obsidian-ok">
        Saved <code>${esc(j.notePath)}</code>.
        <a href="${esc(j.obsidianUri)}">Open in Obsidian</a>
      </div>`;
    } catch (err) {
      status.innerHTML = `<div class="up-err">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  }

  // ── equation flow chart (Mathematics tab) ─────────────────────────────────
  function populateFlow() {
    const host = document.getElementById("flowChart");
    if (!host) return;
    const p = DATA.paper;
    if (p.flow && p.flow.nodes && p.flow.nodes.length) { renderFlow(p.flow); return; }
    if (visionEqs.length >= 2) {
      host.innerHTML = `<p class="cc-none">No flow chart yet — click <b>Build flow chart</b> to connect the equations by their derivation dependencies (reads the Vision LaTeX with the model).</p>`;
    } else {
      host.innerHTML = `<p class="cc-none">Run a <b>Vision LaTeX</b> scan first — the flow chart links those clean equations and each box opens its Vision LaTeX. <button class="open-pdf" id="toVisionFromFlow">Go to Vision tab</button></p>`;
      const t = host.querySelector("#toVisionFromFlow");
      if (t) t.onclick = () => { subTab = "vision"; renderResult(); };
    }
  }

  async function buildFlow(rebuild) {
    const host = document.getElementById("flowChart");
    host.innerHTML = `<p class="cc-none"><span class="spinner spinner-sm"></span> Building the equation flow with <b>${esc(selectedModel)}</b>… (reads the maths; ~30–90 s)</p>`;
    try {
      const r = await fetch("/api/eqflow/" + DATA.paper.id, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, rebuild: !!rebuild }),
      });
      const j = await r.json();
      if (j.needVision) {
        host.innerHTML = `<p class="cc-none">${esc(j.error)} <button class="open-pdf" id="toVisionFromFlow">Go to Vision tab</button></p>`;
        host.querySelector("#toVisionFromFlow").onclick = () => { subTab = "vision"; renderResult(); };
        return;
      }
      if (j.error) throw new Error(j.error);
      DATA.paper.flow = j.flow;
      renderFlow(j.flow);
    } catch (e) {
      host.innerHTML = `<p class="cc-none">${esc(e.message)}</p>`;
    }
  }

  // Flourish-style force-directed layout. Packs in 2D (no wide rows), clusters connected
  // equations, sizes nodes by degree, and applies a gentle top→down derivation-depth bias.
  const CLUSTER_HUES = [265, 188, 330, 150, 42, 210, 292, 110, 18, 240, 168, 312];
  // colour each node by its cluster's base hue, shifted along its derivation depth
  // (early/"given" equations brighter, results deeper) — always varied, encodes real info.
  function nodeColor(depth, maxDepth, cluster) {
    const baseH = CLUSTER_HUES[cluster % CLUSTER_HUES.length];
    const t = maxDepth ? depth / maxDepth : 0;
    const h = ((baseH - t * 58) % 360 + 360) % 360;
    return `hsl(${h.toFixed(0)} 80% ${(71 - t * 17).toFixed(0)}%)`;
  }
  function numOf(label, prefix) { const m = /(\d+)/.exec(label || ""); return m ? (prefix || "") + m[1] : (label || "•"); }
  let NET = null;   // live layout state: { pos, radius, edges, nodePage }

  function layoutNetwork(nodes, edges, opts) {
    opts = opts || {};
    const depthBias = opts.depthBias !== false;   // equation graph: top→down; concept graph: pure 2D
    const N = nodes.length;
    const real = edges.filter((e) => e.from !== e.to);
    // (1) derivation depth via longest-path (capped against cycles) → top→down y bias
    const depth = new Array(N).fill(0);
    for (let it = 0; it < N; it++) {
      let changed = false;
      real.forEach((e) => { if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; } });
      if (!changed) break;
    }
    const maxDepth = Math.max(1, ...depth);
    // (2) degree → node radius
    const deg = new Array(N).fill(0);
    real.forEach((e) => { deg[e.from]++; deg[e.to]++; });
    const radius = opts.radius || deg.map((d) => 13 + 8 * Math.sqrt(d));
    // (3) clusters = weakly-connected components (union-find)
    const par = Array.from({ length: N }, (_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    real.forEach((e) => { const a = find(e.from), b = find(e.to); if (a !== b) par[a] = b; });
    const root2c = {}; let nClusters = 0; const cluster = new Array(N);
    for (let i = 0; i < N; i++) { const r = find(i); if (!(r in root2c)) root2c[r] = nClusters++; cluster[i] = root2c[r]; }
    // (4) canvas + seed positions. Height is BOUNDED (a landscape canvas), NOT scaled by
    // chain depth — otherwise a long derivation chain stretches into a tall vertical smear.
    const area = Math.max(N, 20) * 13000;     // airier spacing (ResearchRabbit-style)
    const W = Math.max(1040, Math.round(Math.sqrt(area) * 1.7));
    const H = Math.max(560, Math.round(Math.sqrt(area) * 1.0));
    const pos = nodes.map((n, i) => ({
      x: W * 0.5 + (Math.random() - 0.5) * W * 0.8,
      y: depthBias ? (70 + (depth[i] / maxDepth) * (H - 140) + (Math.random() - 0.5) * 60)
                   : (70 + Math.random() * (H - 140)),
    }));
    // (5) force simulation
    const K = Math.sqrt(area / Math.max(N, 1)) * 0.9;     // ideal node separation
    const iters = N > 130 ? 240 : 320;
    let alpha = 1;
    for (let it = 0; it < iters; it++) {
      const disp = pos.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < N; i++) {                        // repulsion (O(N²))
        for (let j = i + 1; j < N; j++) {
          let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          let d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2), f = (K * K) / d2;
          const ux = dx / d, uy = dy / d;
          disp[i].x += ux * f; disp[i].y += uy * f; disp[j].x -= ux * f; disp[j].y -= uy * f;
        }
      }
      real.forEach((e) => {                                // attraction along edges
        let dx = pos[e.to].x - pos[e.from].x, dy = pos[e.to].y - pos[e.from].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01, f = (d * d) / (K * 6), ux = dx / d, uy = dy / d;
        disp[e.from].x += ux * f; disp[e.from].y += uy * f; disp[e.to].x -= ux * f; disp[e.to].y -= uy * f;
      });
      for (let i = 0; i < N; i++) {                        // integrate + depth/center bias + cooling
        if (depthBias) disp[i].y += ((70 + (depth[i] / maxDepth) * (H - 140)) - pos[i].y) * 0.055;
        else disp[i].y += (H / 2 - pos[i].y) * 0.006;
        disp[i].x += (W / 2 - pos[i].x) * 0.006;
        const dl = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
        const step = Math.min(dl, 28 * alpha + 1);
        pos[i].x += (disp[i].x / dl) * step; pos[i].y += (disp[i].y / dl) * step;
      }
      alpha *= 0.992;
    }
    // (6) collision resolution (no overlapping circles)
    for (let pass = 0; pass < 14; pass++) {
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        let dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const min = radius[i] + radius[j] + 30;   // extra gap so labels have room
        if (d < min) { const push = (min - d) / 2, ux = dx / d, uy = dy / d;
          pos[i].x -= ux * push; pos[i].y -= uy * push; pos[j].x += ux * push; pos[j].y += uy * push; }
      }
    }
    // (7) normalize bounding box → fixed margin
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, pos[i].x - radius[i]); minY = Math.min(minY, pos[i].y - radius[i]);
      maxX = Math.max(maxX, pos[i].x + radius[i]); maxY = Math.max(maxY, pos[i].y + radius[i]);
    }
    const M = 44;
    for (let i = 0; i < N; i++) { pos[i].x += M - minX; pos[i].y += M - minY; }
    return { pos, radius, cluster, nClusters, depth, maxDepth, width: Math.ceil(maxX - minX + 2 * M), height: Math.ceil(maxY - minY + 2 * M) };
  }

  // curved arrow path from node `from` to node `to`, trimmed to the circle edges
  function netEdgePath(from, to) {
    if (!NET) return "";
    const a = NET.pos[from], b = NET.pos[to], ra = NET.radius[from], rb = NET.radius[to];
    let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / d, uy = dy / d;
    const x1 = a.x + ux * ra, y1 = a.y + uy * ra, x2 = b.x - ux * (rb + 6), y2 = b.y - uy * (rb + 6);
    const mx = (x1 + x2) / 2 + (-uy) * d * 0.11, my = (y1 + y2) / 2 + ux * d * 0.11;
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  function renderFlow(flow) {
    const host = document.getElementById("flowChart");
    if (!host || !flow.nodes || !flow.nodes.length) {
      if (host) host.innerHTML = `<p class="cc-none">No equations to chart.</p>`;
      return;
    }
    const { nodes, edges } = flow;
    const L = layoutNetwork(nodes, edges);
    flowW = L.width;
    // map each node → its source page (so the math-method filter can highlight nodes)
    const nodePage = nodes.map((n, i) => (n.page != null ? n.page : (visionEqs[i] ? visionEqs[i].page : null)));
    NET = { pos: L.pos, radius: L.radius, edges, nodePage };

    let edgeSvg = "";
    edges.forEach((e) => {
      if (e.from === e.to) return;
      edgeSvg += `<path class="flow-edge" data-from="${e.from}" data-to="${e.to}" d="${netEdgePath(e.from, e.to)}" marker-end="url(#fa)"><title>${esc(e.why || "")}</title></path>`;
    });
    const svg = `<svg class="flow-edges" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">
      <defs><marker id="fa" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke"/></marker></defs>${edgeSvg}</svg>`;
    let boxes = "";
    nodes.forEach((n, i) => {
      const p = L.pos[i], r = L.radius[i], col = nodeColor(L.depth[i], L.maxDepth, L.cluster[i]);
      boxes += `<button class="flow-box net-node" data-idx="${i}" title="click → Vision LaTeX · double-click → zoom to its links" style="left:${(p.x - r).toFixed(1)}px;top:${(p.y - r).toFixed(1)}px;width:${(2 * r).toFixed(1)}px;height:${(2 * r).toFixed(1)}px;--nc:${col}">
        <span class="net-label">Eq ${i + 1}</span>
        <span class="net-eq">\\(${n.latex}\\)</span></button>`;
    });
    host.innerHTML = `
      <div class="flow-toolbar">
        <button class="flow-z" data-z="out" title="zoom out">–</button>
        <button class="flow-z" data-z="fit" title="fit the whole graph to the window">fit</button>
        <button class="flow-z" data-z="in" title="zoom in">+</button>
        <span class="flow-meta">${nodes.length} equations · ${edges.length} links · ${L.nClusters} chain${L.nClusters > 1 ? "s" : ""} · drag · double-click → zoom to its links · click → Vision LaTeX</span>
      </div>
      <div class="flow-scroll"><div class="flow-inner net" style="width:${L.width}px;height:${L.height}px">${svg}${boxes}</div></div>
      <div class="flow-axis">earlier · derivation order · later</div>`;
    // adjacency for dependency-path tracing on hover
    const Nn = nodes.length;
    FLOW_ADJF = Array.from({ length: Nn }, () => []);
    FLOW_ADJB = Array.from({ length: Nn }, () => []);
    edges.forEach((e) => { if (e.from !== e.to) { FLOW_ADJF[e.from].push(e.to); FLOW_ADJB[e.to].push(e.from); } });
    host.querySelectorAll(".flow-box").forEach((b) => {
      const idx = parseInt(b.dataset.idx, 10);
      b.addEventListener("mouseenter", () => { if (!b._dragging) { highlightFlow(flowNeighbors(idx)); showFlowPopup(b, idx); } });
      b.addEventListener("mouseleave", () => { clearFlowHighlight(); hideFlowPopup(); });
      wireNodeDrag(b, idx);   // mousedown→drag; no-drag release = click → Vision LaTeX
    });
    host.querySelectorAll(".flow-z").forEach((b) =>
      b.addEventListener("click", () => zoomFlow(b.dataset.z)));
    wireFlowPan(host.querySelector(".flow-scroll"));
    // default: fit very wide charts to the panel so the whole network is visible at a glance
    const wrap = host.querySelector(".flow-scroll");
    flowScale = (flowW > wrap.clientWidth) ? Math.max(0.3, (wrap.clientWidth - 24) / flowW) : 1;
    applyFlowScale();
    if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([host]);
    applyFlowFilter();   // re-apply any active math-method highlight
  }

  // drag a node to rearrange; a release without movement is a click → Vision LaTeX
  function wireNodeDrag(btn, idx) {
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();          // don't start a canvas pan
      const sx = e.clientX, sy = e.clientY, scale = flowScale || 1;
      const ox = NET.pos[idx].x, oy = NET.pos[idx].y, r = NET.radius[idx];
      let moved = false;
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 3) { moved = true; btn._dragging = true; hideFlowPopup(); clearFlowHighlight(); }
        if (!moved) return;
        NET.pos[idx].x = ox + dx; NET.pos[idx].y = oy + dy;
        btn.style.left = (NET.pos[idx].x - r) + "px"; btn.style.top = (NET.pos[idx].y - r) + "px";
        document.querySelectorAll("#flowChart .flow-edge").forEach((p) => {
          const f = +p.dataset.from, t = +p.dataset.to;
          if (f === idx || t === idx) p.setAttribute("d", netEdgePath(f, t));
        });
      };
      const up = () => {
        document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        if (!moved) {
          const now = Date.now();
          if (now - (btn._lastClick || 0) < 300) {   // double-click → zoom into this node's neighbourhood
            btn._lastClick = 0;
            if (btn._clickTimer) { clearTimeout(btn._clickTimer); btn._clickTimer = null; }
            highlightFlow(flowNeighbors(idx));
            flowFitTo(flowNeighbors(idx));
          } else {                                     // single click → open Vision LaTeX (deferred so a 2nd click can cancel it)
            btn._lastClick = now;
            btn._clickTimer = setTimeout(() => { btn._clickTimer = null; goToVisionEq(idx); }, 280);
          }
        }
        setTimeout(() => { btn._dragging = false; }, 0);
      };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
  }

  // floating popup with the (already-typeset) LaTeX of the hovered node
  function showFlowPopup(btn, idx) {
    const host = document.getElementById("flowChart"); if (!host) return;
    let pop = host.querySelector("#flowPopup");
    if (!pop) { pop = document.createElement("div"); pop.id = "flowPopup"; pop.className = "flow-popup"; host.appendChild(pop); }
    const eq = btn.querySelector(".net-eq");
    pop.innerHTML = eq ? eq.innerHTML : "";
    const hb = host.getBoundingClientRect(), bb = btn.getBoundingClientRect();
    pop.style.left = (bb.left - hb.left + bb.width / 2) + "px";
    pop.style.top = (bb.top - hb.top - 8) + "px";
    pop.classList.add("show");
  }
  function hideFlowPopup() { const pop = document.querySelector("#flowChart #flowPopup"); if (pop) pop.classList.remove("show"); }

  // math-method filter → highlight matching nodes (page-proximity rule, like equationsFor)
  function conceptNodeSet(conceptId) {
    if (!NET || conceptId === "all") return null;
    const c = ((DATA.paper.concepts) || []).find((x) => x.id === conceptId);
    if (!c || !c.pages || !c.pages.length) return null;
    const near = new Set();
    c.pages.forEach((pg) => { near.add(pg); near.add(pg - 1); near.add(pg + 1); });
    const set = new Set();
    NET.nodePage.forEach((pg, i) => { if (pg != null && near.has(pg)) set.add(i); });
    return set;
  }
  function applyFlowFilter() {
    const host = document.getElementById("flowChart"); if (!host) return;
    const set = conceptNodeSet(mathSel);
    host.querySelectorAll(".flow-box").forEach((b) =>
      b.classList.toggle("flt-off", !!(set && !set.has(+b.dataset.idx))));
    host.querySelectorAll(".flow-edge").forEach((p) =>
      p.classList.toggle("flt-off", !!(set && !(set.has(+p.dataset.from) && set.has(+p.dataset.to)))));
  }

  // classify math methods from the read equations (for scanned/broken-font PDFs with no text layer)
  async function detectMethods() {
    const btn = document.getElementById("detectMethods");
    if (!visionEqs.length) { if (btn) btn.textContent = "↑ scan the PDF in the Vision LaTeX tab first"; return; }
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner spinner-sm"></span> reading equations with ${esc(selectedModel || "the model")}… (~20–60 s)`; }
    try {
      const j = await (await fetch("/api/detect-methods", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      if (j.concepts && j.concepts.length) {
        DATA.paper.concepts = j.concepts;        // persisted server-side too
        renderResult();                          // re-render → method chips now appear
      } else if (btn) { btn.disabled = false; btn.textContent = j.error || "no methods detected — try a different model"; }
    } catch (e) { if (btn) { btn.disabled = false; btn.textContent = "detection failed — try again"; } }
  }

  // ── topic panel: brief explanation + curated & web references for a math method ──────
  function hideTopicPanel() { const p = document.getElementById("topicPanel"); if (p) p.remove(); }

  function showTopicPanel(cid) {
    const c = conceptById[cid] || { label: cid, icon: "•", definition: "", category: "" };
    const label = c.label || cid;
    hideTopicPanel();
    const panel = document.createElement("aside");
    panel.id = "topicPanel"; panel.className = "topic-panel";
    panel.innerHTML = `
      <div class="tp-head">
        <span class="tp-ic">${esc(c.icon || "•")}</span>
        <div class="tp-h"><strong>${esc(label)}</strong><span>${esc(c.category || "")}</span></div>
        <button class="tp-close" title="close">×</button>
      </div>
      ${c.definition ? `<p class="tp-def">${esc(c.definition)}</p>` : ""}
      <div class="tp-expl-slot"><div class="tp-loading"><span class="spinner spinner-sm"></span> Explaining with <b>${esc(selectedModel || "the model")}</b>… (~20–60 s)</div></div>
      <div class="tp-refs-slot"><div class="tp-loading"><span class="spinner spinner-sm"></span> Finding references…</div></div>
      <p class="tp-hint">Open a link, download the PDF, then add it with <b>+ Add a PDF</b>.</p>`;
    document.body.appendChild(panel);
    panel.querySelector(".tp-close").onclick = hideTopicPanel;
    const live = () => document.getElementById("topicPanel") === panel && mathSel === cid;   // user hasn't moved on
    const refLink = (x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>`;
    const post = (url) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: cid, label }) }).then((r) => r.json());

    // references — fast (no LLM); render as soon as they arrive
    post("/api/topic").then((j) => {
      if (!live()) return;
      const curated = (j.curated || []).map((x) => `<li>${refLink(x)}</li>`).join("");
      const webOk = j.web && j.web.results && j.web.results.length;
      const web = webOk ? j.web.results.map((x) =>
        `<li>${refLink(x)}${x.desc ? `<span class="tp-desc">${esc(x.desc)}</span>` : ""}</li>`).join("") : "";
      const webNote = (!webOk && j.web && (j.web.error || j.web.needsAuth))
        ? `<p class="tp-note">${esc(j.web.error || "Web search unavailable.")}</p>` : "";
      panel.querySelector(".tp-refs-slot").innerHTML =
        (curated ? `<div class="tp-section"><h4>Start here</h4><ul class="tp-refs">${curated}</ul></div>` : "") +
        (web ? `<div class="tp-section"><h4>From the web</h4><ul class="tp-refs">${web}</ul></div>` : webNote);
    }).catch(() => { if (live()) panel.querySelector(".tp-refs-slot").innerHTML = `<p class="tp-note">Couldn't load references.</p>`; });

    // explanation — slower (LLM); streams into its own slot
    post("/api/explain-topic").then((j) => {
      if (!live()) return;
      panel.querySelector(".tp-expl-slot").innerHTML = j.explanation
        ? `<p class="tp-expl">${esc(j.explanation)}</p>`
        : `<p class="tp-note">${esc(j.error || "No explanation available.")}</p>`;
    }).catch(() => { if (live()) panel.querySelector(".tp-expl-slot").innerHTML = `<p class="tp-note">Explanation unavailable.</p>`; });
  }

  function applyFlowScale() {
    const inner = document.querySelector("#flowChart .flow-inner");
    if (inner) {
      inner.style.zoom = flowScale;            // `zoom` keeps scroll footprint correct (Chrome/Safari)
      inner.classList.toggle("show-labels", flowScale >= 0.9);   // reveal node labels when not heavily zoomed out
    }
  }
  function zoomFlow(dir) {
    if (dir === "in") { flowScale = Math.min(2, flowScale * 1.25); applyFlowScale(); }
    else if (dir === "out") { flowScale = Math.max(0.2, flowScale * 0.8); applyFlowScale(); }
    else flowFitTo(null);                        // "fit" → frame the WHOLE graph in the window
  }

  // Zoom + pan so a set of nodes — or the whole graph when idxSet is null — fills the
  // viewport, centred. Used by the "fit" button (all nodes) and by double-clicking a node
  // (that node + its 1-hop links → zoom into its neighbourhood).
  function flowFitTo(idxSet, opts) {
    opts = opts || {};
    const wrap = document.querySelector("#flowChart .flow-scroll");
    if (!wrap || !NET || !NET.pos.length) return;
    const idxs = idxSet ? Array.from(idxSet) : NET.pos.map((_, i) => i);
    if (!idxs.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    idxs.forEach((i) => {
      const p = NET.pos[i], r = NET.radius[i];
      minX = Math.min(minX, p.x - r); minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r); maxY = Math.max(maxY, p.y + r);
    });
    const pad = opts.pad != null ? opts.pad : 50;      // breathing room around the framed set
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const availW = Math.max(1, wrap.clientWidth), availH = Math.max(1, wrap.clientHeight);
    // don't blow a tiny graph past 100%; allow zooming IN when framing a neighbourhood
    const maxScale = opts.maxScale != null ? opts.maxScale : (idxSet ? 1.6 : 1);
    flowScale = Math.max(0.2, Math.min(maxScale, Math.min(availW / bw, availH / bh)));
    applyFlowScale();
    // CSS `zoom` scales layout coords by flowScale, so a layout point (x,y) sits at
    // (x*scale, y*scale) in the scroll content — centre the bbox in the viewport.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const place = () => {
      wrap.scrollLeft = cx * flowScale - availW / 2;
      wrap.scrollTop  = cy * flowScale - availH / 2;
    };
    place(); requestAnimationFrame(place);             // re-place next frame, after `zoom` reflows
  }

  // the equation + its DIRECT dependencies and dependents (1-hop) — ResearchRabbit-style selection
  function flowNeighbors(idx) {
    const set = new Set([idx]);
    (FLOW_ADJF[idx] || []).forEach((y) => set.add(y));
    (FLOW_ADJB[idx] || []).forEach((y) => set.add(y));
    return set;
  }

  // upstream (ancestors) + downstream (descendants) of an equation = its full derivation chain
  function flowPathSet(idx) {
    const set = new Set([idx]);
    let st = [idx];
    while (st.length) { const x = st.pop(); (FLOW_ADJB[x] || []).forEach((y) => { if (!set.has(y)) { set.add(y); st.push(y); } }); }
    st = [idx];
    while (st.length) { const x = st.pop(); (FLOW_ADJF[x] || []).forEach((y) => { if (!set.has(y)) { set.add(y); st.push(y); } }); }
    return set;
  }
  function highlightFlow(set) {
    const host = document.getElementById("flowChart"); if (!host) return;
    host.querySelectorAll(".flow-box").forEach((b) => {
      const on = set.has(+b.dataset.idx);
      b.classList.toggle("lit", on); b.classList.toggle("faded", !on);
    });
    host.querySelectorAll(".flow-edge").forEach((p) => {
      const on = set.has(+p.dataset.from) && set.has(+p.dataset.to);
      p.classList.toggle("lit", on); p.classList.toggle("faded", !on);
    });
  }
  function clearFlowHighlight() {
    const host = document.getElementById("flowChart"); if (!host) return;
    host.querySelectorAll(".flow-box, .flow-edge").forEach((el) => el.classList.remove("lit", "faded"));
  }

  // click-drag the canvas to pan (listeners attach on press, detach on release)
  function wireFlowPan(scroll) {
    if (!scroll) return;
    scroll.addEventListener("mousedown", (e) => {
      if (e.target.closest(".flow-box") || e.target.closest(".flow-z")) return;
      const sx = e.clientX, sy = e.clientY, sl = scroll.scrollLeft, stp = scroll.scrollTop;
      scroll.classList.add("panning");
      const mv = (ev) => { scroll.scrollLeft = sl - (ev.clientX - sx); scroll.scrollTop = stp - (ev.clientY - sy); };
      const up = () => { scroll.classList.remove("panning"); document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      e.preventDefault();
    });
  }

  function goToVisionEq(idx) {
    subTab = "vision"; renderResult();
    setTimeout(() => {
      const items = document.querySelectorAll("#visionList .vis-step");
      const el = items[idx];
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("vis-highlight");
        setTimeout(() => el.classList.remove("vis-highlight"), 2200);
      }
    }, 80);
  }

  // split an LLM derivation into its steps (by markdown headings / bold-only lines)
  function splitDerivation(md) {
    const lines = String(md || "").split("\n");
    const isHead = (l) => /^\s*#{1,6}\s+\S/.test(l) || /^\s*\*\*[^*]+\*\*\s*$/.test(l);
    const titleOf = (l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*\*\*\s*|\s*\*\*\s*$/g, "").trim();
    let pre = [], steps = [], cur = null;
    for (const l of lines) {
      if (isHead(l)) { if (cur) steps.push(cur); cur = { title: titleOf(l), body: [] }; }
      else if (cur) cur.body.push(l);
      else pre.push(l);
    }
    if (cur) steps.push(cur);
    return { pre: pre.join("\n").trim(),
             steps: steps.map((s) => ({ title: s.title, body: s.body.join("\n").trim() })) };
  }

  // render a derivation as drillable step cards (each step → "explain this step")
  function renderDerivation(md) {
    const { pre, steps } = splitDerivation(md);
    if (!steps.length) return `<div class="dstep-pre">${mdToHtml(md)}</div>`;
    return (pre ? `<div class="dstep-pre">${mdToHtml(pre)}</div>` : "") +
      steps.map((s, i) =>
        `<div class="dstep" data-idx="${i}">
           <div class="dstep-head">
             <strong class="gap-h">${esc(s.title)}</strong>
             <button class="substep-btn" data-idx="${i}" title="ask the model to derive this step in detail">explain this step →</button>
           </div>
           <div class="dstep-body">${mdToHtml(s.body)}</div>
         </div>`).join("");
  }

  function wireSubsteps(box) {
    box.querySelectorAll(".substep-btn").forEach((b) => {
      if (b._wired) return;
      b._wired = true;
      b.addEventListener("click", () => explainSubstep(box, parseInt(b.dataset.idx, 10), b));
    });
  }

  // drill into ONE step of the parent derivation (recursive — its steps drill too)
  async function explainSubstep(box, idx, btn) {
    const step = (box._steps || [])[idx];
    if (!step) return;
    const stepEl = btn.closest(".dstep");
    const open = stepEl.querySelector(":scope > .substep-explain");
    if (open) { open.remove(); return; }                       // toggle off
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "thinking…";
    const sub = document.createElement("div");
    sub.className = "gap-explain substep-explain";
    sub.innerHTML = `<div class="gap-loading"><span class="spinner spinner-sm"></span> Deriving this step with <b>${esc(selectedModel)}</b>…</div>`;
    stepEl.appendChild(sub);
    try {
      const ctx = box._ctx || {};
      const r = await fetch("/api/explain-substep", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: step.title + "\n" + step.body, model: selectedModel,
          fromText: ctx.fromText, toText: ctx.toText, fromLabel: ctx.fromLabel, toLabel: ctx.toLabel }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      sub.innerHTML = `<div class="gap-head">
          <span>Step detail · ${esc(step.title).slice(0, 70)}</span>
          <div class="gap-ctrl"><span class="gap-model">${esc(j.model)}</span>
            <button class="gap-min">–</button><button class="gap-close">×</button></div></div>
        <div class="gap-body">${renderDerivation(j.explanation)}</div>`;
      sub._ctx = ctx; sub._steps = splitDerivation(j.explanation).steps;
      sub.querySelector(".gap-min").addEventListener("click", () => sub.classList.toggle("min"));
      sub.querySelector(".gap-close").addEventListener("click", () => sub.remove());
      sub.querySelector(".gap-head > span").addEventListener("click", () => sub.classList.toggle("min"));
      wireSubsteps(sub);
      if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([sub]);
    } catch (e) {
      sub.innerHTML = `<div class="gap-error">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ── derivation gap-filling via the local LLM ──────────────────────────────
  async function runDerive(anchor, payload, label, btn, ctx) {
    const existing = anchor.nextElementSibling;
    if (existing && existing.classList.contains("gap-explain")) { existing.remove(); return; }
    btn.disabled = true;
    const orig = btn.textContent; btn.textContent = "thinking…";
    const box = document.createElement("li");
    box.className = "gap-explain";
    box.innerHTML = `<div class="gap-loading"><span class="spinner spinner-sm"></span> Deriving ${label} with <b>${esc(selectedModel)}</b>… (local models can take 20–60 s)</div>`;
    anchor.after(box);
    try {
      const r = await fetch("/api/explain-step", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, model: selectedModel }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "explain failed");
      box.innerHTML = `<div class="gap-head">
          <span>Derivation · ${esc(String(j.from))} → ${esc(String(j.to))}</span>
          <div class="gap-ctrl">
            <span class="gap-model">${esc(j.model)}</span>
            <button class="gap-min" title="minimize / expand">–</button>
            <button class="gap-close" title="close">×</button>
          </div></div>
        <div class="gap-body">${renderDerivation(j.explanation)}</div>`;
      box._ctx = ctx || { fromLabel: String(j.from), toLabel: String(j.to) };
      box._steps = splitDerivation(j.explanation).steps;
      derivationExports.push({
        label: label || `${j.from} -> ${j.to}`,
        fromSeq: payload.fromSeq || parseInt(String((ctx && ctx.fromLabel) || j.from).match(/\d+/)?.[0] || "0", 10),
        toSeq: (payload.fromSeq ? payload.fromSeq + 1 : parseInt(String((ctx && ctx.toLabel) || j.to).match(/\d+/)?.[0] || "0", 10)),
        explanation: j.explanation,
      });
      box.querySelector(".gap-min").addEventListener("click", () => box.classList.toggle("min"));
      box.querySelector(".gap-close").addEventListener("click", () => box.remove());
      box.querySelector(".gap-head > span").addEventListener("click", () => box.classList.toggle("min"));
      wireSubsteps(box);
      if (window.MathJax && window.MathJax.typesetPromise) window.MathJax.typesetPromise([box]);
    } catch (e) {
      box.innerHTML = `<div class="gap-error">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  function explainStep(seq, btn) {
    const eqs = (DATA && DATA.paper && DATA.paper.equations) || [];
    const cur = eqs.find((e) => e.seq === seq), nxt = eqs.find((e) => e.seq === seq + 1);
    return runDerive(btn.closest(".derive-step"), { fromSeq: seq }, `Eq ${seq} → Eq ${seq + 1}`, btn,
      { fromText: cur ? cur.text : "", toText: nxt ? nxt.text : "",
        fromLabel: "Eq " + seq, toLabel: "Eq " + (seq + 1) });
  }

  function explainStepVision(idx, btn) {
    const a = visionEqs[idx], b = visionEqs[idx + 1];
    if (!a || !b) return;
    const fl = a.label || "Eq " + a.seq, tl = b.label || "Eq " + b.seq;
    const ctx = { fromText: a.latex, toText: b.latex, fromLabel: fl, toLabel: tl };
    return runDerive(btn.closest(".vis-step"),
      { fromText: a.latex, toText: b.latex, fromLabel: fl, toLabel: tl, fromPage: a.page, toPage: b.page },
      `${fl} → ${tl}`, btn, ctx);
  }

  // ── vision LaTeX extraction (page-by-page, works on scanned / broken-font) ──
  function visionItemHtml(it, idx, total) {
    return `<li class="eq-item vis-step" data-idx="${idx}">
        <span class="eq-seq">${esc(it.label || "Eq " + it.seq)}</span>
        <div class="eq-latex">\\[${it.latex}\\]</div>
        <div class="eq-side">
          <button class="eq-fix" data-act="retry" data-idx="${idx}" title="re-read this equation from the page image">↻</button>
          <button class="eq-fix" data-act="edit" data-idx="${idx}" title="edit the LaTeX by hand">✎</button>
          <a class="eq-page" href="${pdfPageHref(it.page)}" target="_blank" rel="noopener">p${it.page} ↗</a>
        </div>
        ${idx < total - 1 ? `<button class="gap-btn vbtn" data-idx="${idx}">explain step →</button>` : ""}
      </li>`;
  }

  // wire explain + retry/edit buttons for the whole vision list
  function wireVisionList(container) {
    container = container || document.getElementById("visionList");
    if (!container) return;
    container.querySelectorAll(".vbtn").forEach((b) =>
      b.addEventListener("click", () => explainStepVision(parseInt(b.dataset.idx, 10), b)));
    container.querySelectorAll(".eq-fix").forEach((b) =>
      b.addEventListener("click", () => (b.dataset.act === "edit" ? startEditVisionEq(+b.dataset.idx) : retryVisionEq(+b.dataset.idx))));
  }

  // typeset (a scope or the whole list) then flag equations whose LaTeX failed to render
  function typesetVision(scope, then) {
    const done = () => { flagBrokenVisionEqs(); if (then) then(); };
    if (window.MathJax && window.MathJax.typesetPromise)
      window.MathJax.typesetPromise([scope || document.getElementById("visionList")]).then(done).catch(done);
    else done();
  }
  function flagBrokenVisionEqs() {
    document.querySelectorAll("#visionList .vis-step").forEach((li) =>
      li.classList.toggle("eq-broken", !!li.querySelector(".eq-latex mjx-merror, .eq-latex merror")));
  }
  const visEqEl = (idx) => document.querySelector(`#visionList .vis-step[data-idx="${idx}"]`);

  function rerenderVisionItem(idx) {
    const li = visEqEl(idx); if (!li) return;
    const t = document.createElement("template");
    t.innerHTML = visionItemHtml(visionEqs[idx], idx, visionEqs.length).trim();
    const fresh = t.content.firstChild;
    li.replaceWith(fresh);
    wireVisionList();
    typesetVision(fresh.querySelector(".eq-latex"));
  }

  async function retryVisionEq(idx) {
    const it = visionEqs[idx], li = visEqEl(idx); if (!li) return;
    li.querySelector(".eq-latex").innerHTML =
      `<span class="eq-busy"><span class="spinner spinner-sm"></span> re-reading page ${it.page} with ${esc(visionModel || "vision model")}…</span>`;
    try {
      const j = await (await fetch("/api/vision-eq", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: it.page, label: it.label, latex: it.latex, model: visionModel }) })).json();
      if (j.latex) { visionEqs[idx].latex = j.latex; saveVisionEqs(); }
    } catch (e) { /* keep previous */ }
    rerenderVisionItem(idx);
  }

  function startEditVisionEq(idx) {
    const li = visEqEl(idx); if (!li) return;
    const slot = li.querySelector(".eq-latex");
    slot.innerHTML = `<textarea class="eq-edit" spellcheck="false">${esc(visionEqs[idx].latex)}</textarea>
      <div class="eq-edit-row"><button class="eq-save">save</button><button class="eq-cancel">cancel</button></div>`;
    const ta = slot.querySelector(".eq-edit"); ta.focus();
    slot.querySelector(".eq-save").onclick = () => { visionEqs[idx].latex = ta.value.trim(); saveVisionEqs(); rerenderVisionItem(idx); };
    slot.querySelector(".eq-cancel").onclick = () => rerenderVisionItem(idx);
  }

  async function retryAllBrokenVisionEqs() {
    const idxs = Array.from(document.querySelectorAll("#visionList .vis-step.eq-broken")).map((li) => +li.dataset.idx);
    for (const i of idxs) await retryVisionEq(i);     // sequential — one vision call at a time
  }

  function saveVisionEqs() {
    fetch("/api/vision-save", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visionEqs: visionEqs.map((e) => ({ page: e.page, latex: e.latex, label: e.label || "" })) }) }).catch(() => {});
  }

  async function runVisionScan() {
    if (visionBusy) { visionStop = true; return; }
    const from = Math.max(1, parseInt(document.getElementById("vpFrom").value, 10) || 1);
    const to = Math.max(from, parseInt(document.getElementById("vpTo").value, 10) || from);
    visionModel = document.getElementById("visionSel").value || visionModel;
    visionBusy = true; visionStop = false;
    const btn = document.getElementById("visionRun"); btn.textContent = "Stop";
    const list = document.getElementById("visionList");
    const prog = document.getElementById("visionProgress");
    visionEqs = []; list.innerHTML = "";
    for (let pg = from; pg <= to && !visionStop; pg++) {
      prog.textContent = `Reading page ${pg} of ${to} with ${visionModel}…`;
      try {
        const j = await (await fetch("/api/vision-page", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page: pg, model: visionModel }),
        })).json();
        (j.equations || []).forEach((e) => {
          if (!e.latex) return;
          const it = { seq: visionEqs.length + 1, page: pg, latex: e.latex, label: e.label };
          visionEqs.push(it);
        });
        list.innerHTML = visionEqs.map((it, i) => visionItemHtml(it, i, visionEqs.length)).join("");
        wireVisionList(list);
        typesetVision();
      } catch (e) { /* skip page */ }
    }
    prog.textContent = `Done — ${visionEqs.length} equation${visionEqs.length === 1 ? "" : "s"} from pages ${from}–${to}.`;
    visionBusy = false; visionStop = false; btn.textContent = "Scan";
  }

  async function fetchModels() {
    try {
      const r = await fetch("/api/models");
      const j = await r.json();
      MODELS = j.models || [];
      // keep the current pick only if it's actually installed; else use the server's auto-detected default
      if (!selectedModel || (MODELS.length && !MODELS.includes(selectedModel)))
        selectedModel = j.default || MODELS[0] || selectedModel || "";
    } catch (e) { /* offline ollama — picker falls back to default */ }
  }

  // ── web references via Firecrawl ──────────────────────────────────────────
  async function fetchWebRefs() {
    const q = (document.getElementById("webrefQuery").value || "").trim();
    const box = document.getElementById("webrefResults");
    const btn = document.getElementById("webrefBtn");
    if (!q) { box.innerHTML = `<p class="cc-none">Type something to search.</p>`; return; }
    btn.disabled = true; const orig = btn.textContent; btn.textContent = "searching…";
    box.innerHTML = `<p class="cc-none"><span class="spinner spinner-sm"></span> Searching the web for “${esc(q)}”…</p>`;
    try {
      const r = await fetch("/api/web-references", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const j = await r.json();
      if (j.needsAuth) {
        box.innerHTML = `<p class="cc-none">Firecrawl isn't authenticated yet. In a terminal run
          <code>firecrawl login --browser</code> (or set <code>FIRECRAWL_API_KEY</code>), then retry.</p>`;
      } else if (j.error) {
        box.innerHTML = `<p class="cc-none">${esc(j.error)}</p>`;
      } else if (!j.results || !j.results.length) {
        box.innerHTML = `<p class="cc-none">No web references found.</p>`;
      } else {
        box.innerHTML = j.results.map((it) =>
          `<a class="webref" href="${esc(it.url)}" target="_blank" rel="noopener">
             <strong>${esc(it.title)}</strong>
             ${it.desc ? `<span>${esc(it.desc)}</span>` : ""}
             <em>${esc(it.url)}</em>
           </a>`).join("");
      }
    } catch (e) {
      box.innerHTML = `<p class="cc-none">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  async function fetchVisionModels() {
    try {
      const j = await (await fetch("/api/vision-models")).json();
      VMODELS = j.models || [];
      VVISION = j.vision || VMODELS.slice();   // which models report vision capability
      visionModel = j.default || VMODELS[0] || "";
    } catch (e) { /* none */ }
  }

  // ── cross-PDF knowledge graph ──────────────────────────────────────────────
  const PDF_COLORS = ["#ff8a4c", "#ff5d9e", "#f5c451", "#7bdcb5", "#5b9bff", "#c084fc"];
  let GRAPH = null;

  async function showGraph() {
    showGraphView();
    const view = document.getElementById("graphView");
    view.innerHTML = `<div class="detail-empty"><span class="spinner spinner-sm"></span> Building the cross-PDF math graph…</div>`;
    try { GRAPH = await (await fetch("/api/graph")).json(); }
    catch (e) { view.innerHTML = `<div class="detail-empty">${esc(e.message)}</div>`; return; }
    if (!GRAPH.papers || !GRAPH.papers.length) {
      view.innerHTML = `<div class="detail-empty">Add some PDFs first — this graph compares the mathematics across your library.</div>`;
      return;
    }
    const model = buildConceptModel();
    const nPdf = model.nodes.filter((n) => n.type === "pdf").length;
    view.innerHTML = `
      <div class="graph-head">
        <div><h2>Mathematics across your library</h2>
          <p class="detail-meta">${GRAPH.papers.length} papers · ${GRAPH.concepts.length} math concepts · shared concepts sit between the papers</p></div>
        <div class="graph-legend">
          <span><i class="lg shared"></i> shared by ≥2 papers</span>
          <span><i class="lg unique"></i> in one paper</span>
          <span><i class="lg pdf"></i> a PDF</span>
        </div>
      </div>
      <div class="graph-stage">
        <div id="cnetChart" class="flow-chart"></div>
      </div>`;
    mountNetwork(document.getElementById("cnetChart"), model, {
      depthBias: false,
      meta: `${nPdf} PDFs · ${model.nodes.length - nPdf} math concepts · drag · hover to trace · click a node`,
      onClick: (i) => {
        const n = model.nodes[i];
        if (n.type === "pdf") selectLibraryPaper(n.id);
        else showConceptDetail(n);
      },
      popupHtml: (n) => n.type === "pdf"
        ? `<strong>${esc(n.label)}</strong><br><span class="cg-pop-sub">PDF · click to open</span>`
        : `<strong>${esc((n.icon || "") + " " + n.label)}</strong><br><span class="cg-pop-sub">used in ${n.paperCount} paper${n.paperCount > 1 ? "s" : ""} · click for usages</span>`,
    });
  }

  function buildConceptModel() {
    const nodes = [], edges = [], idx = {};
    GRAPH.papers.forEach((p, i) => {
      idx["p:" + p.id] = nodes.length;
      nodes.push({ type: "pdf", id: p.id, label: (p.title || "").replace(/\.pdf$/i, "").slice(0, 42),
                   r: 24, color: PDF_COLORS[i % PDF_COLORS.length] });
    });
    GRAPH.concepts.forEach((c) => {
      idx["c:" + c.id] = nodes.length;
      const shared = c.paperCount >= 2;
      nodes.push({ type: "concept", id: c.id, label: c.label, icon: c.icon, papers: c.papers,
                   paperCount: c.paperCount, shared, r: 13 + Math.min(c.paperCount, 6) * 2.5,
                   color: shared ? "hsl(258 80% 68%)" : "hsl(230 12% 62%)" });
    });
    GRAPH.concepts.forEach((c) => {
      const ci = idx["c:" + c.id];
      c.papers.forEach((pp) => { const pi = idx["p:" + pp.pid]; if (pi != null) edges.push({ from: ci, to: pi }); });
    });
    return { nodes, edges };
  }

  // ── generic network renderer — same look & interaction as the Mathematics graph ──
  // (light canvas, hollow degree-sized circles, labels, 1-hop blue selection on hover,
  //  popup, drag/zoom/pan). Used by the cross-PDF concept graph; state kept locally.
  function mountNetwork(host, model, opts) {
    opts = opts || {};
    const nodes = model.nodes, edges = model.edges;
    const radius = nodes.map((n) => n.r || 16);
    const L = layoutNetwork(nodes, edges, { depthBias: opts.depthBias, radius });
    const S = { pos: L.pos, radius: L.radius, scale: 1, W: L.width };
    const adj = nodes.map(() => new Set());
    edges.forEach((e) => { if (e.from !== e.to) { adj[e.from].add(e.to); adj[e.to].add(e.from); } });
    const epath = (f, t) => {
      const a = S.pos[f], b = S.pos[t], ra = S.radius[f], rb = S.radius[t];
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / d, uy = dy / d;
      const x1 = a.x + ux * ra, y1 = a.y + uy * ra, x2 = b.x - ux * rb, y2 = b.y - uy * rb;
      const mx = (x1 + x2) / 2 + (-uy) * d * 0.11, my = (y1 + y2) / 2 + ux * d * 0.11;
      return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    };
    let edgeSvg = "";
    edges.forEach((e) => { if (e.from !== e.to) edgeSvg += `<path class="flow-edge" data-from="${e.from}" data-to="${e.to}" d="${epath(e.from, e.to)}"></path>`; });
    let boxes = "";
    nodes.forEach((n, i) => {
      const p = L.pos[i], r = L.radius[i];
      boxes += `<button class="flow-box net-node${n.type === "pdf" ? " net-pdf" : ""}" data-idx="${i}" style="left:${(p.x - r).toFixed(1)}px;top:${(p.y - r).toFixed(1)}px;width:${(2 * r).toFixed(1)}px;height:${(2 * r).toFixed(1)}px;--nc:${n.color}"><span class="net-label">${esc(n.label)}</span></button>`;
    });
    host.innerHTML = `
      <div class="flow-toolbar">
        <button class="flow-z" data-z="out" title="zoom out">–</button><button class="flow-z" data-z="fit" title="fit the whole graph to the window">fit</button><button class="flow-z" data-z="in" title="zoom in">+</button>
        <span class="flow-meta">${esc(opts.meta || "")}${opts.meta ? " · " : ""}double-click → zoom to its links</span>
      </div>
      <div class="flow-scroll"><div class="flow-inner net show-labels" style="width:${L.width}px;height:${L.height}px">
        <svg class="flow-edges" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">${edgeSvg}</svg>${boxes}</div></div>`;
    const inner = host.querySelector(".flow-inner"), wrap = host.querySelector(".flow-scroll");
    const applyScale = () => { inner.style.zoom = S.scale; };
    // zoom + pan so a set of nodes (or the whole graph when idxSet is null) fills the viewport, centred
    const fitTo = (idxSet) => {
      const idxs = idxSet ? Array.from(idxSet) : S.pos.map((_, k) => k);
      if (!idxs.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      idxs.forEach((k) => { const p = S.pos[k], r = S.radius[k];
        minX = Math.min(minX, p.x - r); minY = Math.min(minY, p.y - r);
        maxX = Math.max(maxX, p.x + r); maxY = Math.max(maxY, p.y + r); });
      const pad = 50; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const availW = Math.max(1, wrap.clientWidth), availH = Math.max(1, wrap.clientHeight);
      const maxScale = idxSet ? 1.6 : 1;     // zoom IN for a neighbourhood; never past 100% for fit-all
      S.scale = Math.max(0.2, Math.min(maxScale, Math.min(availW / bw, availH / bh)));
      applyScale();
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const place = () => { wrap.scrollLeft = cx * S.scale - availW / 2; wrap.scrollTop = cy * S.scale - availH / 2; };
      place(); requestAnimationFrame(place);
    };
    const highlight = (i) => {
      const set = new Set([i]); adj[i].forEach((x) => set.add(x));
      host.querySelectorAll(".flow-box").forEach((b) => { const on = set.has(+b.dataset.idx); b.classList.toggle("lit", on); b.classList.toggle("faded", !on); });
      host.querySelectorAll(".flow-edge").forEach((p) => { const on = set.has(+p.dataset.from) && set.has(+p.dataset.to); p.classList.toggle("lit", on); p.classList.toggle("faded", !on); });
    };
    const clearHi = () => host.querySelectorAll(".flow-box,.flow-edge").forEach((el) => el.classList.remove("lit", "faded"));
    const showPop = (btn, n) => {
      let pop = host.querySelector(".flow-popup");
      if (!pop) { pop = document.createElement("div"); pop.className = "flow-popup"; host.appendChild(pop); }
      pop.innerHTML = opts.popupHtml ? opts.popupHtml(n) : esc(n.label);
      const hb = host.getBoundingClientRect(), bb = btn.getBoundingClientRect();
      pop.style.left = (bb.left - hb.left + bb.width / 2) + "px"; pop.style.top = (bb.top - hb.top - 8) + "px"; pop.classList.add("show");
    };
    const hidePop = () => { const p = host.querySelector(".flow-popup"); if (p) p.classList.remove("show"); };
    host.querySelectorAll(".flow-box").forEach((btn) => {
      const i = +btn.dataset.idx;
      btn.addEventListener("mouseenter", () => { if (!btn._drag) { highlight(i); showPop(btn, nodes[i]); } });
      btn.addEventListener("mouseleave", () => { clearHi(); hidePop(); });
      btn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, ox = S.pos[i].x, oy = S.pos[i].y, r = S.radius[i]; let moved = false;
        const mv = (ev) => {
          const dx = (ev.clientX - sx) / S.scale, dy = (ev.clientY - sy) / S.scale;
          if (!moved && Math.abs(dx) + Math.abs(dy) > 3) { moved = true; btn._drag = true; hidePop(); clearHi(); }
          if (!moved) return;
          S.pos[i].x = ox + dx; S.pos[i].y = oy + dy; btn.style.left = (S.pos[i].x - r) + "px"; btn.style.top = (S.pos[i].y - r) + "px";
          host.querySelectorAll(".flow-edge").forEach((p) => { const f = +p.dataset.from, t = +p.dataset.to; if (f === i || t === i) p.setAttribute("d", epath(f, t)); });
        };
        const up = () => {
          document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
          if (!moved) {
            const now = Date.now();
            if (now - (btn._lastClick || 0) < 300) {        // double-click → zoom into this node's neighbourhood
              btn._lastClick = 0;
              if (btn._clickTimer) { clearTimeout(btn._clickTimer); btn._clickTimer = null; }
              highlight(i); fitTo(new Set([i, ...adj[i]]));
            } else {                                          // single click → caller's action (open concept/PDF), deferred so a 2nd click can cancel it
              btn._lastClick = now;
              btn._clickTimer = setTimeout(() => { btn._clickTimer = null; if (opts.onClick) opts.onClick(i); }, 280);
            }
          }
          setTimeout(() => { btn._drag = false; }, 0);
        };
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      });
    });
    host.querySelectorAll(".flow-z").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.z === "in") { S.scale = Math.min(2, S.scale * 1.25); applyScale(); }
      else if (b.dataset.z === "out") { S.scale = Math.max(0.2, S.scale * 0.8); applyScale(); }
      else fitTo(null);                       // "fit" → frame the WHOLE graph in the window
    }));
    wrap.addEventListener("mousedown", (e) => {
      if (e.target.closest(".flow-box") || e.target.closest(".flow-z")) return;
      const sx = e.clientX, sy = e.clientY, sl = wrap.scrollLeft, st = wrap.scrollTop; wrap.classList.add("panning");
      const mv = (ev) => { wrap.scrollLeft = sl - (ev.clientX - sx); wrap.scrollTop = st - (ev.clientY - sy); };
      const up = () => { wrap.classList.remove("panning"); document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up); e.preventDefault();
    });
    S.scale = S.W > wrap.clientWidth ? Math.max(0.3, (wrap.clientWidth - 24) / S.W) : 1; applyScale();
  }

  // (legacy cross-PDF SVG graph + GSAP animations removed — the graph is now rendered by
  //  mountNetwork above, sharing the look & interaction of the Mathematics network graph)

  // on-demand floating panel (only shown when a concept is clicked — no permanent column)
  function showConceptDetail(n) {
    const view = document.getElementById("graphView");
    let host = document.getElementById("cgraphDetail");
    if (!host) {
      host = document.createElement("aside");
      host.id = "cgraphDetail"; host.className = "graph-detail cg-float";
      view.appendChild(host);
    }
    host.hidden = false;
    const titleOf = (pid) => ((GRAPH.papers.find((p) => p.id === pid) || {}).title || pid).replace(/\.pdf$/i, "");
    host.innerHTML = `
      <button class="cg-close" title="close" aria-label="close">×</button>
      <div class="cg-detail-head">
        <span class="cg-tip-icon" style="color:${n.color}">${esc(n.icon)}</span>
        <div><strong>${esc(n.label)}</strong><span>${n.paperCount} paper${n.paperCount > 1 ? "s" : ""} in your library use this</span></div>
      </div>
      <div class="cg-papers">${n.papers.map((pp) => `
        <article class="cg-paper">
          <div class="cg-paper-top">
            <strong>${esc(titleOf(pp.pid))}</strong>
            <a class="cg-open" href="/api/pdf/${pp.pid}" target="_blank" rel="noopener">open ↗</a>
          </div>
          <span class="cg-paper-meta">used ${pp.count}× · appears on:</span>
          <div class="pg-links">${(pp.pages || []).slice(0, 14).map((pg) =>
            `<a class="pg-link" href="/api/pdf/${pp.pid}#page=${pg}" target="_blank" rel="noopener">p${pg}</a>`).join("") || "<span class='cc-none'>—</span>"}</div>
        </article>`).join("")}</div>`;
    host.querySelector(".cg-close").addEventListener("click", () => { host.hidden = true; });
  }

  // collapsible left sidebar (persisted)
  function wireSidebarToggle() {
    const shell = document.querySelector(".wb-shell"); if (!shell) return;
    const set = (collapsed) => {
      shell.classList.toggle("sidebar-collapsed", collapsed);
      try { localStorage.setItem("wb-sidebar-collapsed", collapsed ? "1" : "0"); } catch (e) {}
    };
    const t = document.getElementById("sideToggle"), r = document.getElementById("sideReopen");
    if (t) t.addEventListener("click", () => set(true));
    if (r) r.addEventListener("click", () => set(false));
    let collapsed = false; try { collapsed = localStorage.getItem("wb-sidebar-collapsed") === "1"; } catch (e) {}
    shell.classList.toggle("sidebar-collapsed", collapsed);
  }

  async function resetAppCache() {
    const btn = document.getElementById("cacheReset");
    if (btn) { btn.disabled = true; btn.textContent = "refreshing..."; }
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      /* reload anyway */
    }
    window.location.href = "/?fresh=" + Date.now();
  }

  function init() {
    wireDropzone(); fetchModels(); fetchVisionModels(); loadLibrary();
    document.getElementById("graphBtn").addEventListener("click", showGraph);
    const cr = document.getElementById("cacheReset");
    if (cr) cr.addEventListener("click", resetAppCache);
    wireSidebarToggle();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
