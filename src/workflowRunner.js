// workflowRunner.js
// Client-side workflow execution engine for Local Agent Studio.
//
// Turns the visual canvas (customToolNodes + manualEdges) into an executable
// DAG, runs each node in topological order passing each node's output to its
// children, and streams live per-node status + step logs back to the UI.
//
// Pure / framework-free: heavy browser helpers (Pyodide, PDF/Docx text
// extraction, CSV parsing) are injected via `helpers` so this module stays
// testable and free of circular imports with main.jsx.

// Skeleton (folder-routing) node ids produced by buildWorkflow() — these are
// NOT executable; when one feeds a tool node it supplies the folder context.
const SKELETON_IDS = new Set([
  "folder", "scanner", "router", "agent", "file-edits",
  "documents", "code", "images", "data", "other",
]);

const STOP_WORDS = new Set(["the","and","for","are","was","with","this","that","have","from","they","will","been","said","each","which","their","there","what","about","when","into","more","also","than","then","some","these","those","would","could","should","very","just","like","well","over","only","such","most","both","after","before","other","your","ours","all","but","not","you","his","her","she","him","who","how","its","yet","nor","can","may","might","shall","upon","even","ever","here","make","made","many","much","them","then","they","were","being","does","done","using","used"]);

const isToolNode = id => typeof id === "string" && id.startsWith("tool-");
const delay = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Run aborted")); }, { once: true });
});

// ─── Topological sort (Kahn's algorithm) ──────────────────────────────────────
export function topoSort(nodeIds, edges) {
  const inDeg = {}, adj = {};
  nodeIds.forEach(id => { inDeg[id] = 0; adj[id] = []; });
  edges.forEach(({ from, to }) => {
    if (adj[from] && inDeg[to] !== undefined) { adj[from].push(to); inDeg[to]++; }
  });
  const queue = nodeIds.filter(id => inDeg[id] === 0);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    (adj[id] || []).forEach(next => { if (--inDeg[next] === 0) queue.push(next); });
  }
  // Append any nodes left in a cycle so they still run (best-effort).
  nodeIds.forEach(id => { if (!sorted.includes(id)) sorted.push(id); });
  return sorted;
}

// ─── Build the executable graph from a workflow ───────────────────────────────
// Returns { nodes:[{id,toolId,label,config,code}], edges:[{from,to}], order, parents }
export function buildRunGraph(workflow) {
  const toolNodes = (workflow.customToolNodes || []).filter(n => n.type !== "stickyNote" && n.data?.customToolId);
  const nodes = toolNodes.map(n => ({
    id: n.id,
    toolId: n.data.customToolId,
    label: n.data.label || n.data.customToolId,
    config: n.data.config || {},
    code: (workflow.pythonNodeCode || {})[n.id] || null,
  }));
  const ids = new Set(nodes.map(n => n.id));

  // Only edges between tool nodes participate in ordering / data flow.
  const toolEdges = (workflow.manualEdges || [])
    .filter(e => ids.has(e.source) && ids.has(e.target))
    .map(e => ({ from: e.source, to: e.target }));

  // A node is "folder-seeded" if it has no tool parent, or an explicit edge
  // from a skeleton/folder node (e.g. agent → tool-x).
  const parents = {};
  nodes.forEach(n => { parents[n.id] = []; });
  toolEdges.forEach(({ from, to }) => parents[to].push(from));
  const folderSeeded = new Set();
  (workflow.manualEdges || []).forEach(e => {
    if (ids.has(e.target) && SKELETON_IDS.has(e.source)) folderSeeded.add(e.target);
  });
  nodes.forEach(n => { if (parents[n.id].length === 0) folderSeeded.add(n.id); });

  const order = topoSort(nodes.map(n => n.id), toolEdges);
  return { nodes, edges: toolEdges, order, parents, folderSeeded, nodeMap: Object.fromEntries(nodes.map(n => [n.id, n])) };
}

// Dry-run: validate the graph and return the planned execution order (labels).
// Used by the Simulate button.
export function planRun(workflow) {
  const g = buildRunGraph(workflow);
  if (!g.nodes.length) return { ok: false, reason: "No tool nodes on the canvas. Drag tools from the palette and connect them.", steps: [] };
  return {
    ok: true,
    steps: g.order.map(id => g.nodeMap[id]).filter(Boolean).map(n => ({ id: n.id, label: n.label, toolId: n.toolId })),
    edgeCount: g.edges.length,
  };
}

// ─── Template interpolation: {{previousOutput.x}}, {{vars.k}}, {{folderName}} ──
function interpolate(str, ctx) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(.+?)\}\}/g, (_, raw) => {
    const key = raw.trim();
    const scope = { previousOutput: ctx.previousOutput, vars: ctx.vars, folderName: ctx.folderName };
    const val = key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), scope);
    return val == null ? "" : (typeof val === "object" ? JSON.stringify(val) : String(val));
  });
}

function asText(v, limit = 4000) {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, limit);
  if (v.text) return String(v.text).slice(0, limit);
  if (Array.isArray(v.files)) return v.files.map(f => f.text || f.content || "").join("\n").slice(0, limit);
  try { return JSON.stringify(v, null, 2).slice(0, limit); } catch { return String(v).slice(0, limit); }
}

const DOC_EXTS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".rtf"]);
const CSV_EXTS = new Set([".csv", ".tsv"]);
const TEXTY_EXTS = new Set([".pdf", ".docx", ".doc", ".txt", ".md", ".py", ".ipynb"]);
const extOf = name => { const i = (name || "").lastIndexOf("."); return i > -1 ? name.slice(i).toLowerCase() : ""; };

// ─── Per-node executors (keyed by TOOL_CATALOG id) ────────────────────────────
// Each returns { output, preview, branch?, halted? }. `preview` is a short
// human-readable string shown in the run console.
const EXECUTORS = {
  // Triggers — start the flow, pass folder context through.
  "trigger-manual":   async (_n, ctx) => ({ output: ctx.folderContext, preview: `Triggered manually · ${ctx.summary.fileCount} files` }),
  "trigger-schedule": async (_n, ctx) => ({ output: ctx.folderContext, preview: "Schedule trigger (fired now)" }),
  "trigger-webhook":  async (_n, ctx) => ({ output: ctx.folderContext, preview: "Webhook trigger (fired now)" }),

  "web-research": async (node, ctx) => {
    const q = interpolate(node.config.query || "", ctx).trim() || ctx.folderName || asText(ctx.previousOutput, 80).trim();
    const engines = {
      "Google Scholar": `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
      "arXiv": `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all`,
      "Google": `https://www.google.com/search?q=${encodeURIComponent(q)}`,
      "Semantic Scholar": `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}&sort=Relevance`,
      "PubMed": `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}`,
    };
    return { output: { query: q, searches: engines }, preview: `Search links for "${q || "(empty)"}"` };
  },

  "api-request": async (node, ctx) => {
    const url = interpolate(node.config.url || "", ctx).trim();
    if (!url) return { output: null, preview: "No URL configured — skipped." };
    const method = node.config.method || "GET";
    const res = await fetch(url, {
      method, signal: ctx.signal,
      body: method !== "GET" && node.config.body ? interpolate(node.config.body, ctx) : undefined,
      headers: { "Content-Type": "application/json" },
    });
    const txt = await res.text();
    let data; try { data = JSON.parse(txt); } catch { data = txt; }
    return { output: { status: res.status, data }, preview: `${method} ${url} → ${res.status}` };
  },

  "document-extractor": async (_node, ctx) => {
    const docs = ctx.files.filter(f => DOC_EXTS.has(extOf(f.name)));
    const out = [];
    for (const f of docs.slice(0, 25)) {
      const x = await ctx.helpers.extractTextContent(f);
      if (x?.content) out.push({ name: f.name, text: x.content, words: x.content.split(/\s+/).filter(Boolean).length, truncated: !!x.truncated });
    }
    const totalWords = out.reduce((a, b) => a + b.words, 0);
    return { output: { files: out }, preview: `Extracted text from ${out.length} document(s) · ${totalWords.toLocaleString()} words` };
  },

  "table-analyzer": async (_node, ctx) => {
    const csv = ctx.files.find(f => CSV_EXTS.has(extOf(f.name)));
    if (!csv) return { output: null, preview: "No CSV/TSV files found — skipped." };
    const x = await ctx.helpers.extractTextContent(csv);
    if (!x?.content) return { output: null, preview: `Could not read ${csv.name}` };
    const { headers, rows } = ctx.helpers.parseCSVText(x.content);
    const stats = ctx.helpers.csvStats(headers, rows);
    return { output: { file: csv.name, headers, rowCount: rows.length, stats }, preview: `${csv.name}: ${rows.length} rows × ${headers.length} cols` };
  },

  "data-cleaner": async (_node, ctx) => {
    const csv = ctx.files.find(f => CSV_EXTS.has(extOf(f.name)));
    if (!csv) return { output: null, preview: "No CSV/TSV files found — skipped." };
    const x = await ctx.helpers.extractTextContent(csv);
    if (!x?.content) return { output: null, preview: `Could not read ${csv.name}` };
    const { headers, rows } = ctx.helpers.parseCSVText(x.content);
    const dups = rows.length - new Set(rows.map(r => JSON.stringify(r))).size;
    const cols = ctx.helpers.csvStats(headers, rows);
    const issues = cols.filter(c => c.missing > 0 || (c.type === "text" && c.unique === 1)).map(c => c.col);
    return { output: { file: csv.name, totalRows: rows.length, duplicates: dups, issues, cols }, preview: `${csv.name}: ${dups} dup rows · ${issues.length} column issue(s)` };
  },

  classifier: async (_node, ctx) => {
    const NAME_TAGS = n => {
      const t = [];
      if (/test/i.test(n)) t.push("Test");
      if (/draft|temp|tmp/i.test(n)) t.push("Draft");
      if (/final|v\d|version/i.test(n)) t.push("Final");
      if (/model|train|predict/i.test(n)) t.push("ML/Model");
      if (/plot|chart|fig|graph/i.test(n)) t.push("Visualization");
      if (/clean|process|prep/i.test(n)) t.push("Data processing");
      return t;
    };
    const counts = {};
    const tagged = ctx.files.slice(0, 500).map(f => {
      const cat = ctx.helpers.classifyFile(f.name);
      const tags = [...new Set([cat, ...NAME_TAGS(f.name)])];
      tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      return { name: f.name, tags };
    });
    return { output: { tagged, tagCounts: counts }, preview: `Tagged ${tagged.length} files · ${Object.keys(counts).length} distinct tags` };
  },

  "insight-summarizer": async (_node, ctx) => {
    // Prefer text already extracted upstream, else read documents from the folder.
    let allText = "";
    const prevFiles = ctx.previousOutput?.files;
    if (Array.isArray(prevFiles) && prevFiles.length) {
      allText = prevFiles.map(f => f.text || f.content || "").join(" ");
    } else {
      const docs = ctx.files.filter(f => TEXTY_EXTS.has(extOf(f.name)));
      for (const f of docs.slice(0, 30)) {
        const x = await ctx.helpers.extractTextContent(f);
        if (x?.content) allText += " " + x.content;
      }
    }
    const words = allText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const freq = {};
    for (const w of words) if (!STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    const topWords = Object.entries(freq).sort(([, a], [, b]) => b - a).slice(0, 30).map(([word, count]) => ({ word, count }));
    return { output: { topWords, totalWords: words.length }, preview: `Top keywords: ${topWords.slice(0, 6).map(t => t.word).join(", ") || "(none)"}` };
  },

  "report-writer": async (_node, ctx) => {
    const s = ctx.summary, now = new Date().toLocaleString();
    const cats = Object.entries(s.categories || {}).filter(([, c]) => c > 0)
      .map(([cat, count]) => `### ${cat} — ${count} file${count !== 1 ? "s" : ""}`).join("\n\n");
    const extra = ctx.previousOutput ? `\n\n## Upstream output\n\n\`\`\`\n${asText(ctx.previousOutput, 1500)}\n\`\`\`` : "";
    const md = `# Workflow Report: ${ctx.folderName || "Untitled"}\n\n_Generated: ${now}_\n\n## Overview\n\n| Metric | Value |\n|---|---|\n| Files | ${s.fileCount} |\n| Total size | ${s.totalSize} |\n\n## Categories\n\n${cats || "_none_"}${extra}\n`;
    return { output: { markdown: md }, preview: `Generated markdown report (${md.length} chars)` };
  },

  "chart-builder": async (_node, ctx) => {
    const csv = ctx.files.find(f => CSV_EXTS.has(extOf(f.name)));
    if (!csv) return { output: null, preview: "No CSV files found — skipped." };
    const x = await ctx.helpers.extractTextContent(csv);
    if (!x?.content) return { output: null, preview: `Could not read ${csv.name}` };
    const { headers } = ctx.helpers.parseCSVText(x.content);
    return { output: { file: csv.name, suggestedX: headers[0], suggestedY: headers[1], type: node?.config?.chartType || "bar" }, preview: `Chart spec for ${csv.name} (X=${headers[0]}, Y=${headers[1]})` };
  },

  "python-step": async (node, ctx) => {
    const code = node.code || `print("Files in folder:", len(files))\nfor f in files[:20]:\n    print(" -", f["path"], f.get("size", 0), "bytes")`;
    const enriched = await ctx.helpers.enrichFilesForPythonRun(ctx.files, ctx.folderName);
    const r = await ctx.helpers.runPythonBrowser(code, enriched, null, node.label || "node.py");
    if (!r.success) throw new Error(r.stderr || "Python execution failed");
    return { output: { stdout: r.stdout, figures: r.figures || [] }, preview: (r.stdout || "(no output)").slice(0, 400) };
  },

  "set-variable": async (node, ctx) => {
    const key = node.config.key, value = interpolate(node.config.value ?? "", ctx);
    if (key) ctx.setVar(key, value);
    return { output: ctx.previousOutput, preview: key ? `Set {{vars.${key}}} = ${String(value).slice(0, 60)}` : "No variable key configured." };
  },

  "text-formatter": async (node, ctx) => {
    let text = asText(ctx.previousOutput);
    const op = node.config.op || "trim";
    if (op === "trim") text = text.trim();
    else if (op === "upper") text = text.toUpperCase();
    else if (op === "lower") text = text.toLowerCase();
    else if (op === "replace") text = text.split(node.config.find || "").join(node.config.replace || "");
    return { output: { text }, preview: `${op}: ${text.slice(0, 80)}` };
  },

  "code-js": async (node, ctx) => {
    const code = node.config.code || "return previousOutput;";
    // eslint-disable-next-line no-new-func
    const fn = new Function("previousOutput", "vars", code);
    const output = fn(ctx.previousOutput, ctx.vars);
    return { output, preview: `JS → ${asText(output, 120)}` };
  },

  "if-else": async (node, ctx) => {
    let pass = true;
    if (node.config.condition) {
      try { pass = !!new Function("previousOutput", "vars", `return (${node.config.condition});`)(ctx.previousOutput, ctx.vars); }
      catch { pass = false; }
    }
    return { output: ctx.previousOutput, branch: pass ? "true" : "false", preview: `Condition → ${pass ? "TRUE" : "FALSE"}` };
  },

  filter: async (node, ctx) => {
    let pass = true;
    if (node.config.condition) {
      try { pass = !!new Function("previousOutput", "vars", `return (${node.config.condition});`)(ctx.previousOutput, ctx.vars); }
      catch { pass = false; }
    }
    return { output: ctx.previousOutput, halted: !pass, preview: pass ? "Passed filter" : "Filtered out — branch halted." };
  },

  loop:  async (_n, ctx) => {
    const arr = Array.isArray(ctx.previousOutput) ? ctx.previousOutput : (ctx.previousOutput?.files || []);
    return { output: ctx.previousOutput, preview: `Would iterate over ${arr.length} item(s)` };
  },
  merge: async (_n, ctx) => ({ output: ctx.previousOutput, preview: "Merged upstream branches" }),
  wait:  async (node, ctx) => { const s = Math.min(300, Number(node.config.seconds) || 2); await delay(s * 1000, ctx.signal); return { output: ctx.previousOutput, preview: `Waited ${s}s` }; },

  "claude-ai": async (node, ctx) => {
    const prompt = interpolate(node.config.prompt || "Summarize the following data and suggest the next step.", ctx);
    const res = await fetch(`${ctx.backendUrl}/api/ai/task`, {
      method: "POST", signal: ctx.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: `${prompt}\n\nDATA:\n${asText(ctx.previousOutput, 6000)}`, folderName: ctx.folderName, summary: ctx.summary, files: [], iterations: 1 }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `AI request failed (${res.status})`); }
    const data = await res.json();
    return { output: { answer: data.answer }, preview: (data.answer || "").slice(0, 400) };
  },

  "ai-suggest": async (_node, ctx) => {
    const res = await fetch(`${ctx.backendUrl}/api/ai/suggest`, {
      method: "POST", signal: ctx.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: ctx.summary, folderName: ctx.folderName, files: ctx.files.slice(0, 50).map(({ name, category, size }) => ({ name, category, size })) }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `Suggest failed (${res.status})`); }
    const data = await res.json();
    return { output: { analysis: data.analysis, suggestions: data.suggestions }, preview: data.analysis || `${(data.suggestions || []).length} suggestion(s)` };
  },

  "slack-notify": async (node, ctx) => ({ output: ctx.previousOutput, preview: `Would post to Slack: ${asText(ctx.previousOutput, 80)}` }),

  "output-display": async (_node, ctx) => ({ output: ctx.previousOutput, preview: `Final output ready · ${asText(ctx.previousOutput, 120)}` }),
};

// ─── Main runner ───────────────────────────────────────────────────────────────
// options: { backendUrl, helpers, onNodeStatus(localId,status), onStep(step), signal }
export async function runWorkflow(workflow, options = {}) {
  const { backendUrl = "http://localhost:3001", helpers = {}, onNodeStatus, onStep, signal } = options;
  const files = workflow.files || [];
  const summary = helpers.summarizeFiles ? helpers.summarizeFiles(files) : { fileCount: files.length, totalSize: "?", categories: {} };
  const folderContext = { kind: "folder", folderName: workflow.folderName, summary, files: files.map(f => ({ name: f.name, path: f.path, category: f.category, size: f.size })) };

  const g = buildRunGraph(workflow);
  const run = {
    id: `run-${Date.now()}`,
    workflowName: workflow.folderName || "Untitled",
    startedAt: new Date().toISOString(),
    finishedAt: null, durationMs: 0, status: "running", steps: [],
  };
  if (!g.nodes.length) {
    run.status = "empty"; run.finishedAt = new Date().toISOString();
    return run;
  }

  const results = {};   // localId → output
  const vars = { ...(workflow.variables || {}) };
  const skipped = new Set();
  const ctxBase = {
    files, folderName: workflow.folderName, summary, folderContext,
    vars, setVar: (k, v) => { vars[k] = v; }, backendUrl, helpers, signal, workflow,
  };
  const t0 = Date.now();

  for (const id of g.order) {
    if (signal?.aborted) break;
    const node = g.nodeMap[id];
    if (!node) continue;
    const parents = g.parents[id] || [];

    // Skip if every parent was halted/skipped (broken branch).
    if (parents.length && parents.every(p => skipped.has(p))) {
      skipped.add(id);
      const step = { nodeId: id, label: node.label, toolId: node.toolId, status: "skipped", preview: "Skipped (upstream halted)", durationMs: 0 };
      run.steps.push(step); onStep?.(step); onNodeStatus?.(id, "skipped");
      continue;
    }

    // Resolve previousOutput: merge tool-parent outputs, else folder context.
    const parentOutputs = parents.map(p => results[p]).filter(v => v !== undefined);
    const previousOutput = g.folderSeeded.has(id) && parentOutputs.length === 0
      ? folderContext
      : (parentOutputs.length === 1 ? parentOutputs[0] : parentOutputs);

    onNodeStatus?.(id, "running");
    const stepStart = Date.now();
    const exec = EXECUTORS[node.toolId];
    let step;
    try {
      if (!exec) throw new Error(`No executor for "${node.toolId}"`);
      const r = await exec(node, { ...ctxBase, previousOutput });
      results[id] = r.output;
      if (r.halted) skipped.add(id); // downstream of a failed filter won't run
      step = { nodeId: id, label: node.label, toolId: node.toolId, status: "done", preview: r.preview || "", output: r.output, branch: r.branch, durationMs: Date.now() - stepStart };
      onNodeStatus?.(id, "done");
    } catch (err) {
      if (err?.message === "Run aborted") { onNodeStatus?.(id, "idle"); break; }
      step = { nodeId: id, label: node.label, toolId: node.toolId, status: "error", error: err.message, durationMs: Date.now() - stepStart };
      onNodeStatus?.(id, "error");
    }
    run.steps.push(step); onStep?.(step);
  }

  run.durationMs = Date.now() - t0;
  run.finishedAt = new Date().toISOString();
  run.aborted = !!signal?.aborted;
  run.status = run.aborted ? "aborted"
    : run.steps.some(s => s.status === "error") ? "partial"
    : "success";
  run.variables = vars;
  return run;
}
