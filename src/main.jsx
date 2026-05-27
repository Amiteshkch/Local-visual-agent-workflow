import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,

  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).href;
import {
  Activity, AlertTriangle, Archive, BarChart3, Bot, BrainCircuit, Braces, CheckCircle2,
  ChevronDown, ChevronRight, ChevronUp, ClipboardList, Clock, Code2, Copy, Database,
  Download, FileImage, FileSearch, FileText, Filter, FolderOpen, GitBranch, GitMerge,
  Globe2, HardDrive, Info, Layers3, Link, LockKeyhole, MessageSquareText, PanelLeftClose,
  PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Settings, ShieldCheck,
  SlidersHorizontal, Sparkles, StickyNote, Table2, Tag, Trash2, Upload, Variable,
  Webhook, XCircle, Zap,
} from "lucide-react";
import "./styles.css";

// ─── constants ────────────────────────────────────────────────────────────────

const EXTENSION_GROUPS = {
  Documents: [".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".pages", ".odt"],
  Code: [".c", ".cpp", ".css", ".go", ".html", ".ipynb", ".java", ".js", ".jsx",
         ".json", ".m", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx",
         ".vue", ".yaml", ".yml"],
  Images: [".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"],
  Data: [".csv", ".db", ".feather", ".jsonl", ".parquet", ".sqlite", ".tsv", ".xls", ".xlsx"],
  Other: [],
};

const CATEGORY_META = {
  Documents: { id: "documents", icon: FileText,  tone: "paper"  },
  Code:      { id: "code",      icon: Braces,    tone: "code"   },
  Images:    { id: "images",    icon: FileImage,  tone: "media"  },
  Data:      { id: "data",      icon: Table2,     tone: "data"   },
  Other:     { id: "other",     icon: Archive,    tone: "other"  },
};

const NODE_TYPES = { workflowNode: WorkflowNode, workflowHeader: WorkflowHeaderNode, stickyNote: StickyNoteNode };

const TOOL_CATALOG = [
  // ── Triggers ──────────────────────────────────────────────────────────────
  { id: "trigger-manual",  label: "Manual Trigger",      category: "Triggers",   subtitle: "Start workflow on demand",            note: "Click 'Run' in the topbar to trigger this workflow manually. Good for on-demand data processing.", icon: Play,    tone: "trigger" },
  { id: "trigger-schedule",label: "Schedule Trigger",    category: "Triggers",   subtitle: "Run on cron schedule (backend)",      note: "Configure a cron expression (e.g. 0 9 * * 1 = every Monday at 9am). Requires backend server.", icon: Clock,   tone: "trigger" },
  { id: "trigger-webhook", label: "Webhook Trigger",     category: "Triggers",   subtitle: "Start via HTTP POST to /api/webhook", note: "Generates a unique webhook URL. POST data to it to start this workflow. Requires backend server.", icon: Webhook, tone: "trigger" },
  // ── Collect ───────────────────────────────────────────────────────────────
  { id: "web-research",    label: "Web Research Agent",  category: "Collect",    subtitle: "Search Scholar, arXiv, Google, PubMed", note: "Double-click to open — enter a topic and launch searches across Google Scholar, arXiv, Semantic Scholar, PubMed, and Google.", icon: Globe2, tone: "agent" },
  { id: "api-request",     label: "HTTP / API Request",  category: "Collect",    subtitle: "GET / POST to any endpoint",          note: "Double-click to configure URL, method, headers, body. Sends via backend proxy or direct fetch. Shows status + JSON response.", icon: Link, tone: "scanner" },
  // ── Parse ─────────────────────────────────────────────────────────────────
  { id: "document-extractor", label: "Document Extractor", category: "Parse",   subtitle: "Extract text from PDF, DOCX, TXT, MD", note: "Double-click to extract readable text from documents. Select multiple files, click Extract, copy all text.", icon: FileText, tone: "paper" },
  { id: "table-analyzer",  label: "CSV / Table Analyzer", category: "Parse",    subtitle: "Preview and profile spreadsheet files", note: "Double-click to parse CSV/TSV — table preview (first 30 rows), column types, min/max/mean, missing values.", icon: Table2, tone: "data" },
  // ── Logic / Control ───────────────────────────────────────────────────────
  { id: "if-else",         label: "If / Else",           category: "Logic",      subtitle: "Branch flow by condition",            note: "Routes execution down True or False branch based on a JS condition. Condition can reference {{previousOutput.field}}.", icon: GitBranch, tone: "router" },
  { id: "filter",          label: "Filter",              category: "Logic",      subtitle: "Stop if condition not met",           note: "Evaluates a condition — if false, halts execution of this branch. Useful for skipping empty results.", icon: Filter, tone: "router" },
  { id: "loop",            label: "Loop / Iterator",     category: "Logic",      subtitle: "Run next nodes for each item",        note: "Iterates over an array from the previous node's output, running downstream nodes once per item.", icon: RefreshCw, tone: "router" },
  { id: "merge",           label: "Merge",               category: "Logic",      subtitle: "Combine multiple branch outputs",     note: "Waits for all connected upstream branches and merges their outputs into a single array.", icon: GitMerge, tone: "router" },
  { id: "wait",            label: "Wait / Delay",        category: "Logic",      subtitle: "Pause execution for N seconds",       note: "Inserts a configurable delay (default 5s, max 300s) before the next node runs. Useful for rate-limiting.", icon: Clock, tone: "router" },
  // ── Transform ─────────────────────────────────────────────────────────────
  { id: "data-cleaner",    label: "Data Cleaner",        category: "Transform",  subtitle: "Detect nulls, duplicates, type issues", note: "Double-click to run a data quality scan on CSV files — reports missing cells, duplicate rows, constant columns.", icon: Filter, tone: "router" },
  { id: "code-js",         label: "Code (JavaScript)",   category: "Transform",  subtitle: "Transform data with custom JS",       note: "Write JS to transform previousOutput. return {…} to pass data to the next node. Runs in the backend sandbox.", icon: Code2, tone: "code" },
  { id: "set-variable",    label: "Set Variable",        category: "Transform",  subtitle: "Store a value to workflow variables", note: "Saves a key-value pair into the workflow's variable store. Other nodes can read it via {{vars.myKey}}.", icon: Variable, tone: "data" },
  { id: "text-formatter",  label: "Text Formatter",      category: "Transform",  subtitle: "Trim, replace, split, join text",     note: "Apply common string operations: trim whitespace, find/replace, split by delimiter, join array to string, upper/lower case.", icon: FileText, tone: "paper" },
  // ── Analyze ───────────────────────────────────────────────────────────────
  { id: "python-step",     label: "Python / IDE Opener", category: "Analyze",    subtitle: "Open .py / .ipynb in VS Code, JupyterLab", note: "Double-click to open the IDE launcher — detects the folder's real path and opens VS Code, Cursor, JupyterLab, or PyCharm.", icon: Braces, tone: "code" },
  { id: "chart-builder",   label: "Chart Builder",       category: "Visualize",  subtitle: "Plot CSV data as bar or line chart", note: "Double-click to load a CSV file, pick X/Y columns, render a live bar or line chart on canvas.", icon: BarChart3, tone: "media" },
  { id: "classifier",      label: "Classifier / Tagger", category: "Analyze",    subtitle: "Auto-tag files by type and name pattern", note: "Double-click to auto-classify all files — tags by extension (Python, Notebook, Data…), size, and filename keywords.", icon: Tag, tone: "agent" },
  { id: "insight-summarizer", label: "Insight Summarizer", category: "Analyze", subtitle: "Word frequency + document stats",     note: "Double-click → Analyse → shows top 30 keywords (frequency cloud), doc count, total words, average doc length.", icon: MessageSquareText, tone: "agent" },
  // ── AI ────────────────────────────────────────────────────────────────────
  { id: "claude-ai",       label: "Claude AI",           category: "AI",         subtitle: "Call Claude with a prompt + data",    note: "Sends a prompt to Claude (Haiku/Sonnet) with the previous node's output. Requires anthropicApiKey in /api/credentials.", icon: Bot, tone: "agent" },
  { id: "ai-suggest",      label: "AI Workflow Suggest", category: "AI",         subtitle: "Let Claude suggest next steps",       note: "Posts folder metadata to Claude and gets 3–5 tool suggestions for this dataset. Requires anthropicApiKey.", icon: Sparkles, tone: "agent" },
  // ── Synthesize ────────────────────────────────────────────────────────────
  { id: "report-writer",   label: "Report Writer",       category: "Synthesize", subtitle: "Generate downloadable markdown report", note: "Double-click → Generate → full structured report: overview, categories, extension breakdown, file listing. Download as .md.", icon: ClipboardList, tone: "paper" },
  // ── Output ────────────────────────────────────────────────────────────────
  { id: "output-display",  label: "Output Display",      category: "Output",     subtitle: "View notebook + Python outputs", note: "Double-click to see notebook output cells or run selected .py files in-browser with captured stdout, errors, and matplotlib plots.", icon: BarChart3, tone: "media" },
  { id: "slack-notify",    label: "Slack Notification",  category: "Output",     subtitle: "Post message to a Slack channel",     note: "Sends a message to a Slack channel when the workflow completes. Requires slackToken in /api/credentials.", icon: MessageSquareText, tone: "agent" },
  { id: "sticky-note",     label: "Sticky Note",         category: "Canvas",     subtitle: "Add an annotation to the canvas",     note: "A free-text sticky note for labelling sections of your workflow. Drag it anywhere; double-click to edit the text.", icon: StickyNote, tone: "other" },
];

const PREVIEWABLE_EXTS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx",
  ".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
  ".py", ".ipynb",
]);
const IMAGE_EXTS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const HEADER_H = 60;
const WF_GAP   = 100;

// ─── helpers ──────────────────────────────────────────────────────────────────

function extensionOf(name = "") {
  const i = name.lastIndexOf(".");
  return i > -1 ? name.slice(i).toLowerCase() : "";
}
function classifyFile(name) {
  const ext = extensionOf(name);
  for (const [cat, exts] of Object.entries(EXTENSION_GROUPS)) {
    if (exts.includes(ext)) return cat;
  }
  return "Other";
}
function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function summarizeFiles(files) {
  const categories = Object.fromEntries(Object.keys(EXTENSION_GROUPS).map(k => [k, 0]));
  const extensions = {};
  let totalBytes = 0, newestModified = 0;
  for (const f of files) {
    const cat = classifyFile(f.name);
    const ext = extensionOf(f.name) || "(none)";
    categories[cat] += 1;
    extensions[ext] = (extensions[ext] || 0) + 1;
    totalBytes += f.size || 0;
    newestModified = Math.max(newestModified, f.lastModified || 0);
  }
  const topExtensions = Object.entries(extensions)
    .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8).map(([extension, count]) => ({ extension, count }));
  return { fileCount: files.length, totalBytes, totalSize: formatBytes(totalBytes),
           categories, topExtensions,
           newestModified: newestModified ? new Date(newestModified).toISOString() : null };
}
// Extracts text content from a file entry — used by the Python panel to load real file data.
// Returns { content, truncated } or null for binary/unsupported types.
const TEXT_EXTS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
  ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".sql", ".sh",
  ".r", ".go", ".java", ".c", ".cpp", ".rb", ".rs", ".php", ".xml",
  ".log", ".ini", ".toml", ".conf", ".ipynb",
]);
const AGENT_CONTEXT_EXTS = new Set([...TEXT_EXTS, ".pdf", ".doc", ".docx"]);
const AGENT_CONTEXT_FILE_LIMIT = 12;
const LOCAL_AGENT_TEAM_LIMIT = 6;
const LOCAL_AGENT_PRESETS = [
  {
    id: "file-inspector",
    name: "File Inspector",
    task: "Inspect the selected files and identify the concrete evidence, important file types, and missing context.",
    iterations: 1,
  },
  {
    id: "workflow-planner",
    name: "Workflow Planner",
    task: "Convert the evidence into exact workflow-builder steps, including which tool nodes should be used next.",
    iterations: 1,
  },
  {
    id: "critical-reviewer",
    name: "Critical Reviewer",
    task: "Review the proposed workflow for missing steps, weak assumptions, unnecessary tools, quota risks, and unclear next actions.",
    iterations: 1,
  },
  {
    id: "prompt-architect",
    name: "Prompt Architect",
    task: "Rewrite rough user instructions into precise coordinator and agent prompts before the team proceeds.",
    iterations: 1,
  },
  {
    id: "python-analyst",
    name: "Python Analyst",
    task: "Inspect Python and notebook files, identify runnable entry points, expected outputs, dependencies, and safe execution steps.",
    iterations: 1,
  },
  {
    id: "data-profiler",
    name: "Data Profiler",
    task: "Inspect data files and recommend profiling, cleaning, and visualization steps based on columns, formats, and likely structure.",
    iterations: 1,
  },
  {
    id: "document-summarizer",
    name: "Document Summarizer",
    task: "Inspect document-style files and identify what should be extracted, summarized, compared, or converted into a report.",
    iterations: 1,
  },
  {
    id: "report-writer",
    name: "Report Writer",
    task: "Turn agent findings into a clear final report structure with conclusions, workflow steps, and remaining assumptions.",
    iterations: 1,
  },
];
const DEFAULT_LOCAL_AGENT_IDS = new Set(["file-inspector", "workflow-planner", "critical-reviewer"]);
const DEFAULT_LOCAL_AGENT_TEAM = LOCAL_AGENT_PRESETS.filter(agent => DEFAULT_LOCAL_AGENT_IDS.has(agent.id));

function makeLocalAgent(spec = {}, idx = 0) {
  return {
    id: `${spec.id || "agent"}-${Date.now()}-${idx}`,
    presetId: spec.presetId || spec.id || "custom",
    name: spec.name || `Agent ${idx + 1}`,
    task: spec.task || "",
    iterations: spec.iterations || 2,
  };
}

async function extractTextContent(fileEntry, maxBytes = 80 * 1024) {
  let file;
  try {
    if (fileEntry.handle)          file = await fileEntry.handle.getFile();
    else if (fileEntry.fileObject) file = fileEntry.fileObject;
    else return null;
  } catch { return null; }

  const ext = extensionOf(file.name);

  if (TEXT_EXTS.has(ext)) {
    try {
      const buf  = await file.slice(0, maxBytes).arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      return { content: text, truncated: file.size > maxBytes };
    } catch { return null; }
  }

  if (ext === ".pdf") {
    try {
      const buf  = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
      const pdf  = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      let text   = "";
      const maxP = Math.min(pdf.numPages, 25);
      for (let i = 1; i <= maxP && text.length < maxBytes; i++) {
        const pg = await pdf.getPage(i);
        const { items } = await pg.getTextContent({ includeMarkedContent: false });
        text += items.map(it => it.str).join(" ") + "\n";
      }
      return { content: text.slice(0, maxBytes).trim(), truncated: pdf.numPages > maxP || text.length > maxBytes };
    } catch { return null; }
  }

  if (ext === ".docx" || ext === ".doc") {
    try {
      const buf    = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buf });
      return { content: result.value.slice(0, maxBytes), truncated: result.value.length > maxBytes };
    } catch { return null; }
  }

  return null; // binary / image — no text extraction
}

function workflowRelativePath(fileEntry, folderName = "") {
  const raw = fileEntry?.path || fileEntry?.name || "";
  return folderName && raw.startsWith(`${folderName}/`)
    ? raw.slice(folderName.length + 1)
    : raw;
}

async function enrichFilesForPythonRun(files = [], folderName = "", maxFiles = 80) {
  let loaded = 0;
  const out = [];
  for (const f of files || []) {
    const base = {
      name: f.name,
      path: workflowRelativePath(f, folderName),
      size: f.size ?? 0,
      category: f.category ?? "Other",
    };
    if (loaded >= maxFiles || !TEXT_EXTS.has(extensionOf(f.name))) {
      out.push(base);
      continue;
    }
    const x = await extractTextContent(f, 512 * 1024);
    if (!x?.content) {
      out.push(base);
      continue;
    }
    loaded++;
    out.push({ ...base, content: x.content, contentTruncated: !!x.truncated });
  }
  return out;
}

async function buildAgentContextFiles(files = [], selectedPaths = new Set(), maxFiles = AGENT_CONTEXT_FILE_LIMIT) {
  const out = [];
  for (const f of files) {
    if (out.length >= maxFiles) break;
    if (!selectedPaths.has(f.path)) continue;
    const ext = extensionOf(f.name);
    if (!AGENT_CONTEXT_EXTS.has(ext)) continue;
    const x = await extractTextContent(f, 48 * 1024);
    out.push({
      name: f.name,
      path: f.path || f.name,
      size: f.size ?? 0,
      category: f.category ?? "Other",
      content: x?.content || "",
      contentTruncated: !!x?.truncated,
    });
  }
  return out;
}

// ─── Pyodide in-browser Python runtime ───────────────────────────────────────
// Loaded once from CDN (~8 MB), then cached for the session.

let _pyodide    = null;
let _pyodideP   = null; // in-flight promise

async function loadPyodideRuntime() {
  if (_pyodide) return _pyodide;
  if (_pyodideP) return _pyodideP;
  _pyodideP = (async () => {
    if (!window.loadPyodide) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    _pyodide = await window.loadPyodide();
    return _pyodide;
  })();
  return _pyodideP;
}

// Returns { success, stdout, stderr, figures: string[] }
// figures are base64 PNGs captured from plt.show() calls.
async function runPythonBrowser(code, files, onStatus, scriptName = "<script>") {
  const py = await loadPyodideRuntime();

  // Make __file__ available to user scripts (many scripts use it for relative paths)
  py.globals.set("__script_name__", `/home/pyodide/${scriptName}`);

  py.globals.set("__files_json__", JSON.stringify(
    files.map(f => ({
      name: f.name, path: f.path ?? f.name,
      size: f.size ?? 0, category: f.category ?? "Other",
      ...(f.content ? { content: f.content, contentTruncated: !!f.contentTruncated } : {}),
    }))
  ));

  await py.runPythonAsync(`
import sys, io, json, base64, os

# Inject standard script globals that Pyodide omits
__name__    = "__main__"
__file__    = __script_name__   # set from JS globals below
__spec__    = None
__loader__  = None
__package__ = None
__builtins__.__dict__["__file__"] = __file__

# Ensure /home/pyodide exists and is the cwd so relative paths and output_dir work
try:
    os.makedirs("/home/pyodide", exist_ok=True)
    os.chdir("/home/pyodide")
except Exception:
    pass

# Patch savefig so any path-based save also captures into _FIGURES
try:
    import matplotlib.pyplot as _plt_pre
    _orig_savefig = _plt_pre.savefig
    def _patched_savefig(fname, *a, **kw):
        if isinstance(fname, str):
            _orig_savefig(fname, *a, **kw)
            try:
                with open(fname, "rb") as _f:
                    _FIGURES.append(base64.b64encode(_f.read()).decode())
            except Exception:
                pass
        else:
            _orig_savefig(fname, *a, **kw)
    _plt_pre.savefig = _patched_savefig
except Exception:
    pass

files           = json.loads(__files_json__)
previous_output = None
_stdout_buf     = io.StringIO()
_stderr_buf     = io.StringIO()
sys.stdout      = _stdout_buf
sys.stderr      = _stderr_buf
_FIGURES        = []
_VIRTUAL_INPUT_PATHS = set()

def _safe_rel_path(path):
    parts = []
    for part in str(path or "").replace("\\\\", "/").lstrip("/").split("/"):
        if part and part not in (".", ".."):
            parts.append(part)
    return "/".join(parts)

def _write_virtual_inputs():
    for f in files:
        if "content" not in f:
            continue
        rel = _safe_rel_path(f.get("path") or f.get("name") or "input.txt")
        if not rel:
            continue
        full = os.path.abspath(os.path.join("/home/pyodide", rel))
        if not full.startswith("/home/pyodide/"):
            continue
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(str(f.get("content") or ""))
        _VIRTUAL_INPUT_PATHS.add(full)

_write_virtual_inputs()
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    def _show(*a, **kw):
        buf = io.BytesIO()
        plt.savefig(buf, format="png", bbox_inches="tight", dpi=150)
        buf.seek(0)
        _FIGURES.append(base64.b64encode(buf.read()).decode())
        buf.close()
        plt.close("all")
    plt.show = _show
except Exception:
    pass
`);

  // Auto-install any packages the code imports (numpy, pandas, etc.)
  try {
    onStatus?.("Installing packages…");
    await py.loadPackagesFromImports(code);
  } catch {}

  let runErr = null;
  onStatus?.("Running…");
  try { await py.runPythonAsync(code); } catch (e) { runErr = e.message; }

  const stdout  = py.runPython("_stdout_buf.getvalue()");
  const stderr  = py.runPython("_stderr_buf.getvalue()");
  const figures = py.runPython("list(_FIGURES)").toJs();
  const artifactsJson = py.runPython(`
import os, json, base64
_TEXT_EXTS = {".txt",".md",".csv",".tsv",".json",".jsonl",".yaml",".yml",".py",".js",".jsx",".ts",".tsx",".html",".css",".sql",".sh",".r",".log",".ini",".toml",".conf"}
_IMAGE_EXTS = {".png",".jpg",".jpeg",".gif",".webp",".svg"}

def _collect_generated_artifacts():
    out = []
    root_dir = "/home/pyodide"
    for root, dirs, names in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
        for name in names:
            full = os.path.abspath(os.path.join(root, name))
            if full in _VIRTUAL_INPUT_PATHS:
                continue
            rel = os.path.relpath(full, root_dir)
            if rel.startswith(".") or "/." in rel:
                continue
            try:
                size = os.path.getsize(full)
            except Exception:
                continue
            ext = os.path.splitext(name)[1].lower()
            if size > 1024 * 1024:
                out.append({"kind": "file", "name": rel, "size": size})
                continue
            try:
                if ext in _IMAGE_EXTS:
                    mode = "r" if ext == ".svg" else "rb"
                    with open(full, mode) as fh:
                        data = fh.read()
                    if ext == ".svg":
                        out.append({"kind": "svg", "name": rel, "svg": data, "size": size})
                    else:
                        out.append({"kind": "image", "name": rel, "b64": base64.b64encode(data).decode(), "size": size})
                elif ext in _TEXT_EXTS:
                    with open(full, "r", encoding="utf-8", errors="replace") as fh:
                        text = fh.read(120000)
                    out.append({"kind": "text", "name": rel, "text": text, "size": size})
                else:
                    out.append({"kind": "file", "name": rel, "size": size})
            except Exception:
                pass
            if len(out) >= 20:
                return out
    return out

json.dumps(_collect_generated_artifacts())
`);

  await py.runPythonAsync("sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__");

  return {
    success: !runErr,
    stdout:  stdout  || "",
    stderr:  [stderr, runErr].filter(Boolean).join("\n").trim(),
    figures: Array.from(figures || []),
    artifacts: JSON.parse(artifactsJson || "[]"),
  };
}

async function scanFolderHandle(directoryHandle) {
  const collected = [];
  async function walk(handle, prefix = "") {
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        collected.push({ name: file.name, path: `${prefix}${file.name}`, size: file.size,
                         type: file.type || "", lastModified: file.lastModified,
                         category: classifyFile(file.name), handle: entry });
      }
      if (entry.kind === "directory") await walk(entry, `${prefix}${entry.name}/`);
    }
  }
  await walk(directoryHandle);
  return collected.sort((a,b) => a.path.localeCompare(b.path));
}

// ─── AI Provider panel ────────────────────────────────────────────────────────

function AIProviderPanel({ onClose }) {
  const [providers, setProviders]     = useState([]);
  const [current,   setCurrent]       = useState("claude");
  const [loading,   setLoading]       = useState(true);
  const [saving,    setSaving]        = useState(false);
  const [saved,     setSaved]         = useState(false);
  const [selected,  setSelected]      = useState(null);
  const [geminiKey, setGeminiKey]     = useState("");
  const [claudeKey, setClaudeKey]     = useState("");
  const [ollamaUrl, setOllamaUrl]     = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3");
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-flash");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/ai/providers`);
      if (r.ok) {
        const d = await r.json();
        setProviders(d.providers || []);
        setCurrent(d.current || "claude");
        setSelected(s => s || d.current || "claude");
        const ol = (d.providers || []).find(p => p.id === "ollama");
        if (ol) { setOllamaUrl(ol.url); setOllamaModel(ol.currentModel); }
        const gm = (d.providers || []).find(p => p.id === "gemini");
        if (gm) setGeminiModel(gm.currentModel || gm.models?.[0] || "gemini-2.5-flash");
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setSaving(true); setSaved(false);
    const body = { aiProvider: selected, ollamaUrl, ollamaModel, geminiModel };
    if (geminiKey) body.geminiApiKey = geminiKey;
    if (claudeKey) body.anthropicApiKey = claudeKey;
    try {
      await fetch(`${BACKEND_URL}/api/ai/provider`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSaved(true); setCurrent(selected);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  }, [selected, ollamaUrl, ollamaModel, geminiModel, geminiKey, claudeKey]);

  const ICONS = {
    ollama: "🦙", gemini: "✨", claude: "🔶",
    "claude-cli": "🔶", "codex-cli": "🟢", "gemini-cli": "✨",
  };
  const isCLI = id => id === "claude-cli" || id === "codex-cli" || id === "gemini-cli";

  return (
    <div className="ai-provider-panel">
      <div className="ai-provider-header">
        <span>🤖 AI Model Provider</span>
        <div style={{ display:"flex", gap:4 }}>
          <button className="ai-provider-btn" onClick={load} title="Re-detect Ollama">↺</button>
          <button className="ai-provider-btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {loading && <p className="ai-provider-hint">Detecting providers…</p>}

      {!loading && providers.length === 0 && (
        <p className="ai-provider-hint">
          Backend not running.<br/>
          <code>cd workflow-engine &amp;&amp; node server.js</code>
        </p>
      )}

      {!loading && providers.length > 0 && (
        <>
          <div className="ai-provider-list">
            {providers.map(p => (
              <div key={p.id}
                   className={`ai-prov-item${selected === p.id ? " sel" : ""}${p.available ? " avail" : ""}`}
                   onClick={() => setSelected(p.id)}>
                <div className="ai-prov-row">
                  <span className="ai-prov-icon">{ICONS[p.id]}</span>
                  <div className="ai-prov-info">
                    <strong>{p.label}</strong>
                    <small className={p.available ? "ai-ok" : "ai-na"}>{p.hint}</small>
                  </div>
                  {current === p.id && <span className="ai-prov-badge">active</span>}
                </div>

                {selected === p.id && (
                  <div className="ai-prov-cfg">
                    {p.id === "ollama" && <>
                      <label className="ai-cfg-lbl">Ollama URL</label>
                      <input className="ai-cfg-inp" value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)} />
                      <label className="ai-cfg-lbl">Model</label>
                      <select className="ai-cfg-inp" value={ollamaModel} onChange={e => setOllamaModel(e.target.value)}>
                        {(p.models || []).map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {!p.available && (
                        <p className="ai-cfg-hint">
                          Install: <a href="https://ollama.com" target="_blank" rel="noreferrer">ollama.com</a> →
                          run <code>ollama pull llama3</code> → click ↺ above
                        </p>
                      )}
                    </>}
                    {p.id === "gemini" && <>
                      <label className="ai-cfg-lbl">API key — free at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">aistudio.google.com</a></label>
                      <input className="ai-cfg-inp" type="password" placeholder="AIza…"
                             value={geminiKey} onChange={e => setGeminiKey(e.target.value)} />
                      <label className="ai-cfg-lbl">Model</label>
                      <select className="ai-cfg-inp" value={geminiModel} onChange={e => setGeminiModel(e.target.value)}>
                        {(p.models || []).map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </>}
                    {p.id === "claude" && <>
                      <label className="ai-cfg-lbl">API key — <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">console.anthropic.com</a></label>
                      <input className="ai-cfg-inp" type="password" placeholder="sk-ant-…"
                             value={claudeKey} onChange={e => setClaudeKey(e.target.value)} />
                    </>}
                    {isCLI(p.id) && <>
                      <p className="ai-cfg-hint" style={{ marginTop:0 }}>
                        <strong>Subscription mode (OAuth/CLI).</strong> Calls run through your installed{" "}
                        <code>{p.id.replace("-cli","")}</code> CLI using your existing
                        {p.id === "claude-cli" ? " Claude Pro/Max" : p.id === "codex-cli" ? " ChatGPT Plus/Pro" : " Google AI Pro/Ultra"}{" "}
                        subscription — no API billing.
                      </p>
                      {p.available ? (
                        <p className="ai-cfg-hint" style={{ color:"var(--green, #22c55e)" }}>
                          ✓ CLI detected at <code>{p.cliPath || "(found)"}</code>
                        </p>
                      ) : (
                        <p className="ai-cfg-hint">
                          ✗ CLI not on PATH.<br/>{p.hint}
                        </p>
                      )}
                      <p className="ai-cfg-hint" style={{ fontStyle:"italic" }}>
                        Slower than API mode (~3–10s per call). Counts toward your subscription's agentic-mode quota.
                      </p>
                    </>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className={`ai-prov-save${saved ? " saved" : ""}`} onClick={save} disabled={saving}>
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save & activate"}
          </button>
        </>
      )}
    </div>
  );
}

function LocalAgentPanel({ workflow, onClose, onRunComplete, onOpenOutput }) {
  const files = workflow?.files ?? [];
  const summary = useMemo(() => summarizeFiles(files), [files]);
  const readableFiles = useMemo(
    () => files.filter(f => AGENT_CONTEXT_EXTS.has(extensionOf(f.name))).slice(0, 80),
    [files]
  );
  const defaultSelection = useMemo(
    () => new Set(readableFiles.slice(0, Math.min(8, AGENT_CONTEXT_FILE_LIMIT)).map(f => f.path)),
    [readableFiles]
  );
  const [task, setTask] = useState("Analyze this folder and tell me what workflow I should run next. Mention the specific files or file types you used.");
  const [agentTeam, setAgentTeam] = useState(() => DEFAULT_LOCAL_AGENT_TEAM.map(makeLocalAgent));
  const [selected, setSelected] = useState(defaultSelection);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [iterations, setIterations] = useState(4);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Live SSE progress:
  //   totalAgents, totalPasses, completedPasses, currentAgent, currentPass, currentTitle, lines[]
  const [progress, setProgress] = useState(null);
  const abortRef = useRef(null);
  const selectedToSend = Math.min(selected.size, AGENT_CONTEXT_FILE_LIMIT);

  // Elapsed-time ticker — updates every second while busy
  useEffect(() => {
    if (!busy) { setElapsedMs(0); return; }
    const startAt = Date.now();
    setElapsedMs(0);
    const t = setInterval(() => setElapsedMs(Date.now() - startAt), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const stopTask = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStatus(null);
    setResult({ error: "Stopped by user." });
  }, []);

  // ── Provider quick-switch (Ollama / Gemini / Claude) ──────────────────────
  const [providers, setProviders] = useState([]);   // [{ id, label, available, models, currentModel }]
  const [currentProvider, setCurrentProvider] = useState("claude");
  const [providerSwitching, setProviderSwitching] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/ai/providers`);
      if (r.ok) {
        const d = await r.json();
        setProviders(d.providers || []);
        setCurrentProvider(d.current || "claude");
      }
    } catch {}
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const switchProvider = useCallback(async (id) => {
    setProviderSwitching(true);
    try {
      await fetch(`${BACKEND_URL}/api/ai/provider`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiProvider: id }),
      });
      setCurrentProvider(id);
    } catch {}
    setProviderSwitching(false);
  }, []);

  useEffect(() => { setSelected(defaultSelection); }, [defaultSelection]);

  const toggleFile = useCallback((path) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const updateAgent = useCallback((id, patch) => {
    setAgentTeam(prev => prev.map(agent => agent.id === id ? { ...agent, ...patch } : agent));
  }, []);

  const addCustomAgent = useCallback(() => {
    setAgentTeam(prev => [
      ...prev,
      makeLocalAgent({
        id: "custom-agent",
        presetId: "custom",
        name: `Custom Agent ${prev.length + 1}`,
        task: "",
        iterations: 2,
      }, prev.length),
    ].slice(0, LOCAL_AGENT_TEAM_LIMIT));
  }, []);

  const addPresetAgent = useCallback((preset) => {
    setAgentTeam(prev => {
      if (prev.length >= LOCAL_AGENT_TEAM_LIMIT) return prev;
      return [...prev, makeLocalAgent({ ...preset, presetId: preset.id }, prev.length)];
    });
  }, []);

  const resetDefaultAgents = useCallback(() => {
    setAgentTeam(DEFAULT_LOCAL_AGENT_TEAM.map(makeLocalAgent));
  }, []);

  const removeAgent = useCallback((id) => {
    setAgentTeam(prev => prev.length <= 1 ? prev : prev.filter(agent => agent.id !== id));
  }, []);

  const runTask = useCallback(async () => {
    const activeAgents = agentTeam
      .map(agent => ({
        id: agent.id,
        name: agent.name.trim() || "Agent",
        task: agent.task.trim(),
        iterations: Math.max(1, Math.min(6, Number(agent.iterations) || 2)),
      }))
      .filter(agent => agent.task)
      .slice(0, LOCAL_AGENT_TEAM_LIMIT);
    if (!task.trim() && activeAgents.length === 0) return;
    const startedAt = Date.now();
    setBusy(true);
    setResult(null);
    setProgress(null);
    setStatus(includeFiles ? "Reading selected files..." : "Sending folder summary...");

    const controller = new AbortController();
    abortRef.current = controller;

    // Update the live progress object based on an SSE event from the backend
    const applyProgressEvent = (event, data) => {
      if (event === "start") {
        setProgress({
          totalAgents: data.totalAgents,
          totalPasses: data.totalPasses,
          completedPasses: 0,
          currentAgent: null,
          currentAgentIdx: 0,
          currentPass: 0,
          currentTitle: "",
          provider: data.provider,
          agents: data.agents,
          lines: [`Starting ${data.totalAgents} agent(s) · ${data.totalPasses} pass(es) total`],
        });
        setStatus(`Starting · ${data.totalAgents} agent · ${data.totalPasses} passes`);
        return;
      }
      if (event === "progress") {
        setProgress(p => {
          if (!p) return p;
          const next = { ...p };
          if (data.phase === "agent-start") {
            next.currentAgent = data.agentName;
            next.currentAgentIdx = data.agentIndex;
            next.currentPass = 0;
            next.lines = [...p.lines, `▶ Agent ${data.agentIndex}/${data.totalAgents}: ${data.agentName} (${data.agentIterations} pass${data.agentIterations === 1 ? "" : "es"})`];
          } else if (data.phase === "pass-start") {
            next.currentPass = data.pass;
            next.currentTitle = data.title;
            setStatus(`${data.agentName} · pass ${data.pass}/${data.total} — ${data.title.split(":")[0]}`);
          } else if (data.phase === "pass-complete") {
            next.completedPasses = p.completedPasses + 1;
            next.lines = [...p.lines, `  ✓ Pass ${data.pass}/${data.total} done (${Math.round(data.durationMs / 1000)}s)`];
          } else if (data.phase === "agent-final-call") {
            setStatus(`${p.currentAgent} · synthesising final answer…`);
            next.lines = [...p.lines, `  ⤷ Final synthesis for ${p.currentAgent}…`];
          } else if (data.phase === "agent-complete") {
            next.lines = [...p.lines, `✓ Agent ${data.agentIndex}/${data.totalAgents} (${data.agentName}) done in ${Math.round(data.durationMs / 1000)}s`];
          } else if (data.phase === "synthesizing") {
            setStatus("Coordinator synthesising all agents…");
            next.currentAgent = "Coordinator";
            next.lines = [...p.lines, "▶ Coordinator: synthesising all agents"];
          } else if (data.phase === "agent-error") {
            next.lines = [...p.lines, `✗ ${data.agentName} failed: ${data.message}`];
          }
          return next;
        });
      }
    };

    try {
      const contextFiles = includeFiles ? await buildAgentContextFiles(files, selected, AGENT_CONTEXT_FILE_LIMIT) : [];
      const requestBody = JSON.stringify({
        task,
        folderName: workflow?.folderName || "Unnamed",
        summary,
        files: contextFiles,
        iterations,
        agents: activeAgents,
      });

      // 1) Try streaming endpoint /api/ai/task-stream (SSE) for live progress
      let data = null;
      let streamFailed = false;
      let streamReason = "";

      try {
        const res = await fetch(`${BACKEND_URL}/api/ai/task-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
          body: requestBody,
          signal: controller.signal,
        });

        // Detect "endpoint not present" → falls back to non-streaming
        const contentType = res.headers.get("content-type") || "";
        if (res.status === 404 || !contentType.includes("text/event-stream")) {
          streamFailed = true;
          streamReason = res.status === 404
            ? "Streaming endpoint not found — backend likely needs restart. Falling back…"
            : `Backend returned ${contentType || "no content-type"} instead of SSE — falling back to non-streaming…`;
        } else if (!res.ok) {
          // SSE response but error status — try to read the message
          try {
            const t = await res.text();
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
          } catch (e) { throw e; }
        } else if (!res.body) {
          streamFailed = true;
          streamReason = "No response body — falling back to non-streaming…";
        } else {
          // Read the stream
          const reader  = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";
            for (const block of events) {
              if (!block.trim()) continue;
              let eventName = "message", dataLine = "";
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
              }
              if (!dataLine) continue;
              let payload;
              try { payload = JSON.parse(dataLine); } catch { continue; }
              if (eventName === "complete") data = payload;
              else if (eventName === "error") throw new Error(payload.message || "Stream error");
              else applyProgressEvent(eventName, payload);
            }
          }
          if (!data) {
            streamFailed = true;
            streamReason = "Stream ended without a result — falling back to non-streaming…";
          }
        }
      } catch (streamErr) {
        if (streamErr.name === "AbortError") throw streamErr;
        streamFailed = true;
        streamReason = `Stream error: ${streamErr.message} — falling back…`;
      }

      // 2) Fallback: non-streaming POST /api/ai/task (older backend or stream failure)
      if (streamFailed && !data) {
        // Set a "batch mode" progress so the header chip + result panel show
        // a meaningful status instead of an indefinite "Connecting…" spinner.
        const totalPasses = activeAgents.reduce((s, a) => s + a.iterations, 0);
        setProgress({
          mode: "batch",
          totalAgents: activeAgents.length,
          totalPasses,
          completedPasses: 0,
          currentAgent: null,
          currentAgentIdx: 0,
          currentPass: 0,
          currentTitle: "",
          provider: null,
          agents: activeAgents.map(a => ({ id: a.id, name: a.name, iterations: a.iterations })),
          lines: [
            `⚠ ${streamReason}`,
            `▶ Running ${activeAgents.length} agent${activeAgents.length === 1 ? "" : "s"} (${totalPasses} pass${totalPasses === 1 ? "" : "es"}) in BATCH mode — no live updates.`,
            `   Restart the backend (cd workflow-engine && node server.js) for live per-pass progress next time.`,
            `   Estimated wait: ${totalPasses * 5}s–${totalPasses * 75}s depending on model.`,
          ],
        });
        setStatus(`Running ${activeAgents.length} agent${activeAgents.length === 1 ? "" : "s"} in batch mode — restart backend for live updates`);
        const res2 = await fetch(`${BACKEND_URL}/api/ai/task`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });
        const d = await res2.json();
        if (!res2.ok) throw new Error(d.error || `HTTP ${res2.status}`);
        data = d;
      }

      if (!data) throw new Error("No result from either streaming or non-streaming endpoint.");
      setResult(data);
      const agentText = (data.agents || [])
        .map(agent => `Agent: ${agent.name}
Task: ${agent.task}
Passes: ${agent.iterations}

${(agent.steps || []).map(s => `Pass ${s.index}: ${s.title}\n${s.output}`).join("\n\n")}

Agent answer:
${agent.answer}`)
        .join("\n\n");
      onRunComplete?.({
        timestamp: new Date().toISOString(),
        duration: Date.now() - startedAt,
        success: true,
        stdout: `Coordinator task\n${task || "(agent tasks only)"}\n\nAgent outputs\n${agentText || "(none)"}\n\nFinal answer\n${data.answer}`,
        stderr: "",
        figures: [],
        provider: data.provider,
        usedFiles: data.usedFiles || [],
      });
      onOpenOutput?.();
    } catch (e) {
      // If the user clicked Stop, the abort handler already set the message — don't overwrite
      if (e.name === "AbortError") return;
      setResult({ error: e.message });
      onRunComplete?.({
        timestamp: new Date().toISOString(),
        duration: Date.now() - startedAt,
        success: false,
        stdout: "",
        stderr: e.message,
        figures: [],
      });
    } finally {
      abortRef.current = null;
      setStatus(null);
      setBusy(false);
    }
  }, [task, agentTeam, includeFiles, iterations, files, selected, workflow?.folderName, summary, onRunComplete, onOpenOutput]);

  return (
    <div className="local-agent-panel">
      <div className="local-agent-header">
        <div className="local-agent-title">
          <Bot size={16} />
          <strong>Local AI Agent</strong>
          {workflow?.folderName && <span>{files.length} files - "{workflow.folderName}"</span>}
        </div>
        <div className="local-agent-actions">
          {providers.length > 0 && (
            <select
              className="local-agent-provider"
              value={currentProvider}
              onChange={e => switchProvider(e.target.value)}
              disabled={busy || providerSwitching}
              title="Switch the AI model provider for this run"
            >
              {providers.map(p => (
                <option key={p.id} value={p.id} disabled={!p.available && p.id !== "claude"}>
                  {p.id === "ollama" ? "🦙" : p.id === "gemini" ? "✨" : "🔶"}{" "}{p.label}{!p.available && p.id !== currentProvider ? " (not set)" : ""}
                </option>
              ))}
            </select>
          )}
          {busy && (() => {
            const mm = Math.floor(elapsedMs / 60000);
            const ss = Math.floor(elapsedMs / 1000) % 60;
            const tooltip = `Running for ${mm}m ${ss}s`;
            let label;
            let isBatch = false;

            if (progress?.mode === "batch") {
              // Non-streaming fallback — show batch-mode status with elapsed time
              isBatch = true;
              label = `Batch mode · ${mm}:${String(ss).padStart(2, "0")} · restart backend for live status`;
            } else if (progress) {
              if (progress.currentAgent === "Coordinator") {
                label = `Coordinator · synthesising`;
              } else if (progress.currentAgent) {
                const passInfo = progress.currentPass > 0 ? ` · pass ${progress.currentPass}` : "";
                const agentInfo = progress.totalAgents > 1 ? ` (${progress.currentAgentIdx}/${progress.totalAgents})` : "";
                label = `${progress.currentAgent}${agentInfo}${passInfo}`;
              } else {
                label = `Starting · ${progress.totalAgents} agent${progress.totalAgents !== 1 ? "s" : ""} · ${progress.totalPasses} passes`;
              }
            } else {
              label = "Connecting…";
            }
            const pct = progress && !isBatch
              ? Math.round((progress.completedPasses / Math.max(1, progress.totalPasses)) * 100)
              : 0;
            return (
              <span className={`local-agent-live-chip${isBatch ? " local-agent-live-chip--batch" : ""}`} title={tooltip}>
                <span className="lalc-spinner">⟳</span>
                <span className="lalc-label">{label}</span>
                {progress && !isBatch && (
                  <span className="lalc-progress">
                    <span className="lalc-progress-fill" style={{ width: `${pct}%` }} />
                    <span className="lalc-progress-num">{progress.completedPasses}/{progress.totalPasses}</span>
                  </span>
                )}
              </span>
            );
          })()}
          {busy
            ? <button className="local-agent-stop" onClick={stopTask} title="Cancel the running task">■ Stop</button>
            : <button className="local-agent-run" onClick={runTask} disabled={!task.trim() && agentTeam.every(agent => !agent.task.trim())}>Run task</button>
          }
          <button className="py-close-btn" onClick={onClose} title="Close">x</button>
        </div>
      </div>

      <div className="local-agent-body">
        <div className="local-agent-task">
          <div className="local-agent-label">Coordinator task</div>
          <textarea
            className="local-agent-textarea"
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder="Ask the agent to analyze, summarize, plan, compare, extract, or decide the next workflow step..."
            spellCheck={false}
          />
          <div className="local-agent-team-head">
            <span>Agent team</span>
            <div className="local-agent-team-actions">
              <button type="button" onClick={resetDefaultAgents} disabled={busy} title="Restore default agents">
                Defaults
              </button>
              <button type="button" onClick={addCustomAgent} disabled={busy || agentTeam.length >= LOCAL_AGENT_TEAM_LIMIT}>
                <Plus size={12} /> Custom
              </button>
            </div>
          </div>
          <div className="local-agent-preset-list">
            {LOCAL_AGENT_PRESETS.map(preset => {
              const added = agentTeam.some(agent => agent.presetId === preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={added ? "added" : ""}
                  onClick={() => addPresetAgent(preset)}
                  disabled={busy || added || agentTeam.length >= LOCAL_AGENT_TEAM_LIMIT}
                  title={added ? "Already in team" : preset.task}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>
          <div className="local-agent-team-list">
            {agentTeam.map((agent) => (
              <div key={agent.id} className="local-agent-card">
                <div className="local-agent-card-head">
                  <input
                    value={agent.name}
                    onChange={e => updateAgent(agent.id, { name: e.target.value })}
                    disabled={busy}
                    aria-label="Agent name"
                  />
                  <button
                    type="button"
                    onClick={() => removeAgent(agent.id)}
                    disabled={busy || agentTeam.length <= 1}
                    title="Remove agent"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <textarea
                  value={agent.task}
                  onChange={e => updateAgent(agent.id, { task: e.target.value })}
                  disabled={busy}
                  placeholder="Focused task for this agent..."
                  spellCheck={false}
                />
                <div className="local-agent-pass-row">
                  <span>Passes</span>
                  <div className="local-agent-pass-buttons">
                    {[1, 2, 4, 6].map(n => (
                      <button
                        key={n}
                        type="button"
                        className={agent.iterations === n ? "active" : ""}
                        onClick={() => updateAgent(agent.id, { iterations: n })}
                        disabled={busy}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="local-agent-team-hint">
            <strong>Total LLM calls: {agentTeam.reduce((s, a) => s + (Number(a.iterations) || 1), 0)}</strong>
            {" "}({agentTeam.length} agent{agentTeam.length === 1 ? "" : "s"} × their pass counts).
            {" "}Roughly ~30–90s per call with Ollama on CPU, ~2–10s with cloud APIs.
            {" "}Fewer passes = faster runs.
          </div>
          <div className="local-agent-context-head">
            <label className="local-agent-toggle">
              <input type="checkbox" checked={includeFiles} onChange={e => setIncludeFiles(e.target.checked)} />
              Include selected file text
            </label>
            <span>{selected.size} selected</span>
          </div>
          {includeFiles && (
            <div className="local-agent-context-cap">
              Sends up to {selectedToSend} selected file{selectedToSend === 1 ? "" : "s"} per run.
            </div>
          )}
          <div className="local-agent-context-actions">
            <button onClick={() => setSelected(new Set(readableFiles.slice(0, AGENT_CONTEXT_FILE_LIMIT).map(f => f.path)))}>First {AGENT_CONTEXT_FILE_LIMIT}</button>
            <button onClick={() => setSelected(new Set(readableFiles.map(f => f.path)))}>Select shown</button>
            <button onClick={() => setSelected(new Set())}>None</button>
          </div>
          <div className="local-agent-file-list">
            {readableFiles.length === 0 && <p>No readable text, code, PDF, or Word files found.</p>}
            {readableFiles.map(f => (
              <label key={f.path} className="local-agent-file-row" title={f.path}>
                <input
                  type="checkbox"
                  checked={selected.has(f.path)}
                  onChange={() => toggleFile(f.path)}
                  disabled={!includeFiles}
                />
                <span>{f.path}</span>
                <small>{formatBytes(f.size)}</small>
              </label>
            ))}
          </div>
        </div>

        <div className="local-agent-output">
          <div className="local-agent-label">Agent result</div>
          {!result && !busy && (
            <div className="local-agent-empty">Run a task to generate an answer and send it to Output Display.</div>
          )}
          {busy && (
            <div className="local-agent-progress">
              <div className="lap-progress-status">
                <span className="lap-progress-spinner">⟳</span>
                <span className="lap-progress-text">{status || "Running…"}</span>
              </div>

              {progress && (
                <>
                  <div className="lap-progress-bar-wrap">
                    <div
                      className="lap-progress-bar"
                      style={{ width: `${Math.min(100, Math.round((progress.completedPasses / Math.max(1, progress.totalPasses)) * 100))}%` }}
                    />
                  </div>
                  <div className="lap-progress-meta">
                    <span>{progress.completedPasses} / {progress.totalPasses} passes</span>
                    {progress.currentAgent && (
                      <span>Agent {progress.currentAgentIdx}/{progress.totalAgents}: <strong>{progress.currentAgent}</strong></span>
                    )}
                    {progress.currentPass > 0 && (
                      <span>Pass {progress.currentPass}</span>
                    )}
                    {progress.provider && <span className="lap-provider-chip">{progress.provider}</span>}
                  </div>
                  {progress.currentTitle && (
                    <div className="lap-progress-title">📍 {progress.currentTitle}</div>
                  )}
                  <div className="lap-progress-log">
                    {progress.lines.slice(-12).map((line, i) => (
                      <div key={i} className="lap-log-line">{line}</div>
                    ))}
                  </div>
                </>
              )}

              {!progress && (
                <p className="lap-progress-hint">Connecting to the AI provider…</p>
              )}
            </div>
          )}
          {result?.answer && (
            <>
              <div className="local-agent-meta">
                Provider: {result.provider || "unknown"}
                {result.iterations ? ` | ${result.iterations} pass(es)` : ""}
                {result.usedFiles?.length ? ` | ${result.usedFiles.length} file(s) used` : ""}
              </div>
              {result.agents?.length > 0 ? (
                <div className="local-agent-steps">
                  {result.agents.map(agent => (
                    <details key={agent.id} className="local-agent-agent" open>
                      <summary>
                        <span>{agent.name}</span>
                        <strong>{agent.iterations} pass{agent.iterations === 1 ? "" : "es"}</strong>
                      </summary>
                      <p>{agent.task}</p>
                      {(agent.steps || []).map(step => (
                        <details key={`${agent.id}-${step.index}`} className="local-agent-step" open={step.index === agent.steps.length}>
                          <summary>
                            <span>Pass {step.index}</span>
                            <strong>{step.title}</strong>
                          </summary>
                          <OutputViewer text={step.output} />
                        </details>
                      ))}
                      <div className="local-agent-final-label">Agent answer</div>
                      <OutputViewer text={agent.answer} />
                    </details>
                  ))}
                </div>
              ) : result.steps?.length > 0 && (
                <div className="local-agent-steps">
                  {result.steps.map(step => (
                    <details key={step.index} className="local-agent-step" open={step.index === result.steps.length}>
                      <summary>
                        <span>Pass {step.index}</span>
                        <strong>{step.title}</strong>
                      </summary>
                      <OutputViewer text={step.output} />
                    </details>
                  ))}
                </div>
              )}
              <div className="local-agent-final-label">Final answer</div>
              <OutputViewer text={result.answer} />
            </>
          )}
          {result?.error && <OutputViewer text={result.error} isError />}
        </div>
      </div>
    </div>
  );
}

// ─── Workflow templates ───────────────────────────────────────────────────────

// Each template defines:
//   tools[]   — tool IDs in order (used to generate node IDs tool-{id}-{1-based-index})
//   layout[]  — {x,y} position for each tool node (same order as tools[])
//   edges[]   — {from, to} where a value is either a base node id ("folder","scanner",
//               "router","agent") or a 0-based index into tools[] for tool nodes
// Each template defines:
//   tools[]   — tool IDs in order (node IDs = tool-{id}-{1-based-index})
//   layout[]  — {x,y} for each tool node (same order as tools[])
//   edges[]   — {from,to}: base node name ("folder","scanner","router","agent")
//               OR 0-based index into tools[] for tool nodes
//
// Every template ends with "output-display" so results are always viewable.
const WORKFLOW_TEMPLATES = [
  {
    id: "research-pipeline",
    label: "Research Paper Analysis",
    description: "Scans PDFs, extracts text, classifies by topic, summarises keywords, writes a report, and shows results.",
    tags: ["Documents", "Research", "NLP"],
    tools: ["document-extractor", "classifier", "insight-summarizer", "report-writer", "output-display"],
    layout: [
      { x: 950,  y: 380 },   // 0 document-extractor  ─┐ parallel
      { x: 950,  y: 580 },   // 1 classifier           ─┘ → merge
      { x: 1260, y: 480 },   // 2 insight-summarizer (merges both branches)
      { x: 1570, y: 480 },   // 3 report-writer
      { x: 1880, y: 480 },   // 4 output-display ← view results here
    ],
    edges: [
      { from: "router", to: 0 },
      { from: "router", to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: "agent" },
    ],
  },
  {
    id: "csv-analysis",
    label: "CSV Data Analysis Pipeline",
    description: "Profiles CSV columns, detects quality issues, builds charts, and shows the output visually.",
    tags: ["Data", "CSV", "Charts"],
    tools: ["table-analyzer", "data-cleaner", "chart-builder", "report-writer", "output-display"],
    layout: [
      { x: 950,  y: 450 },   // 0 table-analyzer
      { x: 1260, y: 450 },   // 1 data-cleaner
      { x: 1570, y: 450 },   // 2 chart-builder
      { x: 1880, y: 450 },   // 3 report-writer
      { x: 2190, y: 450 },   // 4 output-display ← view results here
    ],
    edges: [
      { from: "router", to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: "agent" },
    ],
  },
  {
    id: "code-review",
    label: "Code Repository Scanner",
    description: "Opens Python/notebook files in your IDE, extracts text, classifies scripts, generates a code index report, and shows output.",
    tags: ["Code", "Python", "Notebooks"],
    tools: ["python-step", "document-extractor", "classifier", "report-writer", "output-display"],
    layout: [
      { x: 950,  y: 450 },   // 0 python-step (open in IDE)
      { x: 1260, y: 450 },   // 1 document-extractor
      { x: 1570, y: 450 },   // 2 classifier
      { x: 1880, y: 450 },   // 3 report-writer
      { x: 2190, y: 450 },   // 4 output-display ← view results here
    ],
    edges: [
      { from: "router", to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: "agent" },
    ],
  },
  {
    id: "web-research",
    label: "Web Research + Summarise",
    description: "Searches Google Scholar / arXiv, summarises findings with Claude AI, writes a report, and shows output.",
    tags: ["Research", "Web", "AI"],
    tools: ["web-research", "insight-summarizer", "claude-ai", "report-writer", "output-display"],
    layout: [
      { x: 950,  y: 450 },   // 0 web-research
      { x: 1260, y: 450 },   // 1 insight-summarizer
      { x: 1570, y: 450 },   // 2 claude-ai
      { x: 1880, y: 450 },   // 3 report-writer
      { x: 2190, y: 450 },   // 4 output-display ← view results here
    ],
    edges: [
      { from: "scanner", to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: "agent" },
    ],
  },
  {
    id: "data-etl",
    label: "Data ETL + Visualise",
    description: "Fetches API data, cleans and transforms it with JS, builds charts, sends a Slack notification, and displays all output.",
    tags: ["API", "Transform", "Charts"],
    tools: ["api-request", "data-cleaner", "code-js", "chart-builder", "slack-notify", "output-display"],
    layout: [
      { x: 660,  y: 450 },   // 0 api-request
      { x: 970,  y: 450 },   // 1 data-cleaner
      { x: 1280, y: 450 },   // 2 code-js
      { x: 1590, y: 450 },   // 3 chart-builder
      { x: 1900, y: 450 },   // 4 slack-notify
      { x: 2210, y: 450 },   // 5 output-display ← view results here
    ],
    edges: [
      { from: "folder", to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: 5 },
      { from: 5, to: "agent" },
    ],
  },
  {
    id: "ai-folder-audit",
    label: "AI Folder Audit",
    description: "Sends folder metadata to Claude for suggestions, classifies all files, builds a full audit report, and shows output.",
    tags: ["AI", "Audit", "All files"],
    tools: ["ai-suggest", "classifier", "insight-summarizer", "report-writer", "output-display"],
    layout: [
      { x: 950,  y: 450 },   // 0 ai-suggest
      { x: 1260, y: 450 },   // 1 classifier
      { x: 1570, y: 450 },   // 2 insight-summarizer
      { x: 1880, y: 450 },   // 3 report-writer
      { x: 2190, y: 450 },   // 4 output-display ← view results here
    ],
    edges: [
      { from: "scanner", to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: "agent" },
    ],
  },
];

function WorkflowTemplatesModal({ onSelect, onClose }) {
  const [hovered, setHovered] = useState(null);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span><Sparkles size={16}/> Start from a template</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="templates-grid">
          {WORKFLOW_TEMPLATES.map(t => (
            <div key={t.id}
                 className={`template-card${hovered === t.id ? " template-card--hover" : ""}`}
                 onMouseEnter={() => setHovered(t.id)}
                 onMouseLeave={() => setHovered(null)}
                 onClick={() => { onSelect(t); onClose(); }}>
              <div className="template-name">{t.label}</div>
              <div className="template-desc">{t.description}</div>
              <div className="template-tags">{t.tags.map(tag => <span key={tag} className="template-tag">{tag}</span>)}</div>
              <div className="template-tools">
                {t.tools.map(toolId => {
                  const tool = TOOL_CATALOG.find(c => c.id === toolId);
                  return tool ? <span key={toolId} className="template-tool">{tool.label}</span> : null;
                })}
              </div>
            </div>
          ))}
          <div className="template-card template-card--blank" onClick={() => { onSelect(null); onClose(); }}>
            <Plus size={28} strokeWidth={1.5}/>
            <div className="template-name">Blank workflow</div>
            <div className="template-desc">Start with an empty canvas.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Command palette ──────────────────────────────────────────────────────────

function CommandPalette({ onAddTool, onClose }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const lq = q.toLowerCase().trim();
    return lq
      ? TOOL_CATALOG.filter(t =>
          [t.label, t.category, t.subtitle, ...(t.tags ?? [])].some(v => v?.toLowerCase().includes(lq))
        ).slice(0, 8)
      : TOOL_CATALOG.slice(0, 8);
  }, [q]);

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-box" onClick={e => e.stopPropagation()}>
        <div className="palette-search-row">
          <Search size={16} className="palette-search-icon"/>
          <input ref={inputRef} className="palette-input" value={q}
                 onChange={e => setQ(e.target.value)}
                 placeholder="Search nodes… (e.g. CSV, AI, Python)"
                 onKeyDown={e => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && results[0]) { onAddTool(results[0]); onClose(); } }} />
          <kbd className="palette-esc">Esc</kbd>
        </div>
        <div className="palette-results">
          {results.map(tool => {
            const Icon = tool.icon || Layers3;
            return (
              <div key={tool.id} className="palette-result" onClick={() => { onAddTool(tool); onClose(); }}>
                <span className={`palette-icon tone-${tool.tone}`}><Icon size={15}/></span>
                <div className="palette-result-text">
                  <span className="palette-result-label">{tool.label}</span>
                  <span className="palette-result-cat">{tool.category}</span>
                </div>
                <span className="palette-result-sub">{tool.subtitle}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Canvas floating toolbar ──────────────────────────────────────────────────

function CanvasToolbar({ onAddNote, onFitView, onSearch, onTemplate, onImport }) {
  return (
    <div className="canvas-toolbar">
      <button className="ctb-btn" onClick={onTemplate} title="Start from template"><Sparkles size={15}/> Templates</button>
      <div className="ctb-sep"/>
      <button className="ctb-btn" onClick={onSearch}   title="Search nodes (Ctrl+K)"><Search size={15}/> Add node</button>
      <button className="ctb-btn" onClick={onAddNote}  title="Add sticky note"><StickyNote size={15}/> Note</button>
      <div className="ctb-sep"/>
      <button className="ctb-btn" onClick={onFitView}  title="Fit all workflows in view"><Layers3 size={15}/> Fit view</button>
      <button className="ctb-btn" onClick={onImport}   title="Import workflow JSON"><Upload size={15}/> Import</button>
    </div>
  );
}

// ─── Workflow variables panel ─────────────────────────────────────────────────

function WorkflowVariablesPanel({ variables, onChange }) {
  const [newKey, setNewKey]   = useState("");
  const [newVal, setNewVal]   = useState("");
  const [open,   setOpen]     = useState(false);

  const add = () => {
    const k = newKey.trim();
    if (!k) return;
    onChange({ ...variables, [k]: newVal });
    setNewKey(""); setNewVal("");
  };

  const remove = (k) => {
    const v = { ...variables };
    delete v[k];
    onChange(v);
  };

  return (
    <section className={`panel vars-panel${open ? " vars-panel--open" : ""}`}>
      <div className="panel-title vars-toggle" onClick={() => setOpen(o => !o)}>
        <Variable size={15}/> Variables
        <span className="vars-count">{Object.keys(variables).length}</span>
        {open ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
      </div>
      {open && (
        <div className="vars-body">
          {Object.entries(variables).map(([k, v]) => (
            <div key={k} className="var-row">
              <span className="var-key">{k}</span>
              <input className="var-val" defaultValue={v}
                     onBlur={e => onChange({ ...variables, [k]: e.target.value })} />
              <button className="var-del" onClick={() => remove(k)}><Trash2 size={11}/></button>
            </div>
          ))}
          <div className="var-add-row">
            <input className="var-new-key" value={newKey} onChange={e => setNewKey(e.target.value)}
                   placeholder="key" onKeyDown={e => e.key === "Enter" && add()} />
            <input className="var-new-val" value={newVal} onChange={e => setNewVal(e.target.value)}
                   placeholder="value" onKeyDown={e => e.key === "Enter" && add()} />
            <button className="var-add-btn" onClick={add}><Plus size={12}/></button>
          </div>
          <p className="vars-hint">Use <code>{"{{vars.key}}"}</code> in any node config.</p>
        </div>
      )}
    </section>
  );
}

// ─── Sticky note node ─────────────────────────────────────────────────────────

function StickyNoteNode({ data, id }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.text ?? "Double-click to edit this note…");
  const textareaRef = useRef(null);

  useEffect(() => { if (editing) textareaRef.current?.focus(); }, [editing]);

  const save = () => {
    setEditing(false);
    data.onTextChange?.(id, text);
  };

  const COLORS = ["#fef9c3","#dcfce7","#dbeafe","#fce7f3","#f3e8ff"];
  const [colorIdx, setColorIdx] = useState(data.colorIdx ?? 0);

  return (
    <div className="sticky-node" style={{ background: COLORS[colorIdx] }}
         onDoubleClick={() => setEditing(true)}>
      <div className="sticky-node-toolbar">
        {COLORS.map((c, i) => (
          <button key={i} className={`sticky-color${colorIdx === i ? " active" : ""}`}
                  style={{ background: c }}
                  onMouseDown={e => { e.stopPropagation(); setColorIdx(i); data.onColorChange?.(id, i); }} />
        ))}
        <button className="sticky-del" onMouseDown={e => { e.stopPropagation(); data.onDelete?.(id); }}>
          <Trash2 size={11}/>
        </button>
      </div>
      {editing ? (
        <textarea ref={textareaRef} className="sticky-textarea"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onBlur={save}
                  onKeyDown={e => { if (e.key === "Escape") save(); }}
                  style={{ background: "transparent" }} />
      ) : (
        <div className="sticky-text">{text}</div>
      )}
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

// ─── canvas builders ──────────────────────────────────────────────────────────

function workflowRowHeight(files) {
  const s = summarizeFiles(files);
  const n = Object.values(s.categories).filter(c => c > 0).length;
  if (n === 0) return 440;
  const sy = Math.max(20, 260 - ((n-1)*130)/2);
  return Math.max(440, sy + (n-1)*130 + 200);
}

function buildWorkflow(files, folderName, runState, customToolNodes = [], fileEdits = []) {
  const summary = summarizeFiles(files);
  const hasFiles = summary.fileCount > 0;
  const activeCategories = Object.entries(summary.categories).filter(([,c]) => c > 0);
  const categoryEntries = hasFiles ? activeCategories : Object.entries(summary.categories).slice(0,4);
  const categorySpacing = 130;
  const categoryStartY = Math.max(20, 260 - ((categoryEntries.length-1)*categorySpacing)/2);

  const mkFileList = arr => arr.slice(0,200).map(f => ({
    path: f.path || f.name, name: f.name,
    handle: f.handle || null, fileObject: f.fileObject || null,
  }));

  const nodes = [
    { id:"folder",  type:"workflowNode", position:{x:40,  y:220},
      data:{ label:"Folder Access", subtitle: folderName||"Permission not granted", icon:FolderOpen,
             tone:"trigger", status: folderName?"Granted":"Waiting",
             metrics:[{label:"Mode",value:"Read only"}],
             note:"The browser asks before exposing local metadata.",
             fileList: mkFileList(files), drillable:true }},
    { id:"scanner", type:"workflowNode", position:{x:350, y:220},
      data:{ label:"File Scanner", subtitle:"Paths, sizes, dates, extensions", icon:FileSearch,
             tone:"scanner", status: hasFiles?"Ready":"Idle",
             metrics:[{label:"Files",value:summary.fileCount},{label:"Size",value:summary.totalSize}],
             fileList: mkFileList(files) }},
    { id:"router",  type:"workflowNode", position:{x:660, y:220},
      data:{ label:"Type Router", subtitle:"Groups files into workflow branches", icon:GitBranch,
             tone:"router", status: hasFiles?"Mapped":"Preview",
             metrics: Object.entries(summary.categories).filter(([,c])=>c>0).slice(0,4).map(([label,value])=>({label,value})),
             note: hasFiles?"Only populated branches are shown.":"Connect a folder to expand branches." }},
    { id:"agent",   type:"workflowNode", position:{x:1280,y:220},
      data:{ label:"Local AI Agent", subtitle:"Double-click → AI Suggest · or configure Claude API", icon:Bot,
             tone:"agent", status: runState==="running"?"Running":hasFiles?"Ready":"Waiting",
             metrics:[{label:"Source",value:"Metadata"},{label:"Mode",value:"Rule-based"}],
             note:"Double-click to run AI Suggest (sends file metadata to Claude and recommends tools). Requires anthropicApiKey in /api/credentials — start the backend first." }},
  ];

  if (hasFiles) {
    categoryEntries.forEach(([category, count], index) => {
      const meta = CATEGORY_META[category];
      const catFiles = files.filter(f => f.category === category);
      nodes.push({ id:meta.id, type:"workflowNode",
        position:{ x:970, y:categoryStartY+index*categorySpacing },
        data:{ label:category, subtitle:`${count} ${count===1?"file":"files"} detected`,
               icon:meta.icon, tone:meta.tone, status:"Active",
               metrics:[{label:"Count",value:count}],
               fileList: mkFileList(catFiles), category, drillable:true }});
    });
  }

  // File edits branch
  const hasEdits = fileEdits.length > 0;
  if (hasEdits) {
    const lastEdit = fileEdits[fileEdits.length - 1];
    const editedFileNames = [...new Set(fileEdits.map(e => e.fileName))];
    nodes.push({
      id: "file-edits", type: "workflowNode",
      position: { x: 1580, y: 220 },
      data: {
        label: "File Annotations", subtitle: `${fileEdits.length} edit${fileEdits.length!==1?"s":""} recorded`,
        icon: Pencil, tone: "code", status: "Updated",
        metrics: [
          { label: "Files", value: editedFileNames.length },
          { label: "Last edit", value: new Date(lastEdit.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) },
        ],
        note: editedFileNames.slice(0,3).join(", ") + (editedFileNames.length>3 ? ` +${editedFileNames.length-3} more`:""),
        fileList: fileEdits.map(e => ({
          path: `${new Date(e.timestamp).toLocaleString()}: [${e.type}] ${e.excerpt} — ${e.fileName}`,
          name: e.fileName, handle: null, fileObject: null,
        })),
      },
    });
  }

  const edgePairs = [["folder","scanner"],["scanner","router"],["router","agent"]];
  if (hasFiles) {
    for (const [cat] of categoryEntries) edgePairs.push(["router",CATEGORY_META[cat].id],[CATEGORY_META[cat].id,"agent"]);
  }
  if (hasEdits) edgePairs.push(["agent","file-edits"]);

  return {
    summary, nodes: [...nodes, ...customToolNodes],
    edges: edgePairs.map(([source,target],i) => ({
      id:`edge-${source}-${target}-${i}`, source, target, type:"smoothstep",
      animated: (target==="agent"&&hasFiles) || target==="file-edits",
      markerEnd:{ type:MarkerType.ArrowClosed, width:18, height:18 },
      style:{ strokeWidth:2.3 },
    })),
  };
}

function buildCombinedCanvas(workflowList, activeWorkflowId, fileChanges = {}) {
  let yOffset = 0;
  const allNodes = [], allEdges = [];
  for (const wf of workflowList) {
    const edits = fileChanges[wf.id] || [];
    const built = buildWorkflow(wf.files, wf.folderName, wf.runState, wf.customToolNodes, edits);

    allNodes.push({
      id: `${wf.id}|header`, type:"workflowHeader",
      position:{ x:40, y:yOffset }, draggable:false, selectable:false,
      data:{ folderName: wf.folderName||"New workflow", workflowId:wf.id,
             isActive: wf.id===activeWorkflowId, fileCount:wf.files.length,
             editCount: edits.length },
    });
    for (const node of built.nodes) {
      allNodes.push({ ...node, id:`${wf.id}|${node.id}`,
        position:{ x:node.position.x, y:node.position.y+yOffset+HEADER_H },
        data:{ ...node.data, workflowId:wf.id, nodeYOffset:yOffset+HEADER_H }});
    }
    for (const edge of [...built.edges, ...wf.manualEdges]) {
      allEdges.push({ ...edge, id:`${wf.id}|${edge.id}`,
        source:`${wf.id}|${edge.source}`, target:`${wf.id}|${edge.target}` });
    }
    yOffset += workflowRowHeight(wf.files) + HEADER_H + WF_GAP;
  }
  return { nodes:allNodes, edges:allEdges };
}

function toExportableWorkflow(workflow) {
  return {
    nodes: workflow.nodes.map(n => ({ id:n.id, type:n.type, position:n.position,
      data:{ label:n.data.label, subtitle:n.data.subtitle, tone:n.data.tone,
             status:n.data.status, metrics:n.data.metrics||[], note:n.data.note||"" } })),
    edges: workflow.edges.map(e => ({ id:e.id, source:e.source, target:e.target, type:e.type, animated:e.animated })),
  };
}

// ─── node components ──────────────────────────────────────────────────────────

function WorkflowHeaderNode({ data }) {
  return (
    <div className={`wf-header-node${data.isActive?" wf-header-node--active":""}`}>
      <span className="wf-header-name" title={data.folderName}>{data.folderName}</span>
      {data.fileCount > 0 && <span className="wf-header-count">{data.fileCount} files</span>}
      {data.editCount > 0 && <span className="wf-header-count" style={{background:"#ffe8dc",color:"#b84214"}}>{data.editCount} edits</span>}
      <button className="wf-header-remove"
        onPointerDown={e=>{ e.stopPropagation(); data.onRemove?.(data.workflowId); }}
        title="Remove workflow" aria-label="Remove workflow">
        <XCircle size={15} />
      </button>
    </div>
  );
}

function WorkflowNode({ data }) {
  const Icon = data.icon || Layers3;
  const [showFiles, setShowFiles] = useState(false);
  return (
    <div className={`workflow-node tone-${data.tone||"default"}${data.drillable?" node-drillable":""}`}
         onMouseEnter={()=>setShowFiles(true)} onMouseLeave={()=>setShowFiles(false)}>
      <Handle type="target" position={Position.Left} />
      <div className="node-heading">
        <span className="node-icon"><Icon size={18} strokeWidth={2.2} /></span>
        <span className="node-copy"><strong>{data.label}</strong><small>{data.subtitle}</small></span>
        <span className="node-status">{data.status}</span>
      </div>
      {Boolean(data.metrics?.length) && (
        <div className="node-metrics">
          {data.metrics.map(m=>(
            <span className="node-metric" key={`${m.label}-${m.value}`}>
              <small>{m.label}</small><strong>{m.value}</strong>
            </span>
          ))}
        </div>
      )}
      {data.note && <p className="node-note">{data.note}</p>}
      {showFiles && data.fileList?.length > 0 && (
        <div className="node-file-list" onMouseDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
          <div className="node-file-list-header">
            {data.fileList.length} item{data.fileList.length!==1?"s":""}
            {data.fileList.length>=200&&" · first 200 shown"}
            {data.drillable&&<span className="node-drill-hint"> · click node to drill down</span>}
          </div>
          <div className="node-file-scroll">
            {data.fileList.map((item,i)=>{
              const isObj = typeof item==="object"&&item!==null;
              const name  = isObj?item.name:item;
              const path  = isObj?item.path:item;
              const ext   = extensionOf(name);
              const canOpen = PREVIEWABLE_EXTS.has(ext)&&isObj&&(item.handle||item.fileObject);
              return (
                <div key={i}
                     className={`node-file-item${canOpen?" node-file-item--previewable":""}`}
                     title={canOpen?`Click to open ${name}`:path}
                     onClick={canOpen?e=>{e.stopPropagation();data.onFileOpen?.(item,data.workflowId);}:undefined}>
                  {canOpen&&<span className="file-open-dot"/>}
                  {path}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ─── annotation toolbar ───────────────────────────────────────────────────────

function AnnToolbar({ pos, onApply, onDismiss }) {
  if (!pos) return null;
  const tools = [
    { id:"highlight",     label:"H",  title:"Highlight" },
    { id:"underline",     label:"U",  title:"Underline" },
    { id:"strikethrough", label:"S",  title:"Strikethrough" },
  ];
  // Always use fixed positioning with raw client coords — no scroll/offset issues
  return (
    <div className="ann-toolbar"
         style={{ position:"fixed", left: pos.cx, top: pos.cy - 52, zIndex: 9999 }}
         onMouseDown={e => e.stopPropagation()}>
      {tools.map(t => (
        <button key={t.id} className={`ann-btn ann-btn--${t.id}`} title={t.title}
                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onApply(t.id); }}>
          {t.label}
        </button>
      ))}
      <button className="ann-btn ann-btn--dismiss" title="Dismiss" onMouseDown={onDismiss}>✕</button>
    </div>
  );
}

// ─── PDF viewer with annotation ───────────────────────────────────────────────

function PDFAnnotationViewer({ arrayBuffer, annotations, onAnnotate }) {
  const containerRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [toolbar, setToolbar] = useState(null); // { x, y, text }
  const pdfRef = useRef(null);
  const SCALE = 1.4;

  useEffect(() => {
    if (!arrayBuffer) return;
    let cancelled = false;
    (async () => {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      pdfRef.current = pdf;
      if (cancelled) return;
      setPages(Array.from({ length: pdf.numPages }, (_, i) => i + 1));
    })();
    return () => { cancelled = true; };
  }, [arrayBuffer]);

  // Multiply two PDF transform matrices (each is a 6-element flat array)
  const mulTransform = (t1, t2) => [
    t1[0]*t2[0] + t1[2]*t2[1],
    t1[1]*t2[0] + t1[3]*t2[1],
    t1[0]*t2[2] + t1[2]*t2[3],
    t1[1]*t2[2] + t1[3]*t2[3],
    t1[0]*t2[4] + t1[2]*t2[5] + t1[4],
    t1[1]*t2[4] + t1[3]*t2[5] + t1[5],
  ];

  const renderPage = useCallback(async (pageNum, canvasEl, textEl) => {
    if (!pdfRef.current || !canvasEl || !textEl) return;
    const page     = await pdfRef.current.getPage(pageNum);
    const viewport = page.getViewport({ scale: SCALE });

    canvasEl.width  = viewport.width;
    canvasEl.height = viewport.height;
    await page.render({ canvasContext: canvasEl.getContext("2d"), viewport }).promise;

    textEl.style.width  = `${viewport.width}px`;
    textEl.style.height = `${viewport.height}px`;
    textEl.innerHTML = "";

    const { items } = await page.getTextContent({ includeMarkedContent: false });
    const vt = viewport.transform;

    for (const item of items) {
      if (!item.str?.trim()) continue;
      const tx = mulTransform(vt, item.transform);

      // Derive font size and position from the combined transform matrix.
      // tx[3] is the vertical scale (negative due to y-flip); its magnitude = rendered font height.
      // tx[5] is the CSS baseline position; text renders above baseline by fontHeight.
      const fontHeight = Math.max(2, Math.abs(tx[3]));
      const fontWidth  = Math.abs(tx[0]);
      const angle      = Math.atan2(tx[1], tx[0]);

      const span = document.createElement("span");
      span.textContent = item.str;

      const styles = [
        "position:absolute",
        `left:${tx[4]}px`,
        `top:${tx[5] - fontHeight}px`,
        `font-size:${fontHeight}px`,
        "font-family:sans-serif",
        "white-space:pre",
        "color:transparent",
        "user-select:text",
        "-webkit-user-select:text",
        "cursor:text",
        "pointer-events:all",
        "transform-origin:left top",
      ];

      let xform = "";
      if (Math.abs(angle) > 0.01) xform += ` rotate(${angle}rad)`;
      // Handle horizontal scaling relative to vertical
      if (fontHeight > 0 && Math.abs(fontWidth / fontHeight - 1) > 0.12) {
        xform += ` scaleX(${fontWidth / fontHeight})`;
      }
      if (xform) styles.push(`transform:${xform.trim()}`);

      span.style.cssText = styles.join(";");
      textEl.appendChild(span);
    }

    // Re-apply stored annotations
    annotations.forEach(ann => {
      if (ann.page !== pageNum) return;
      textEl.querySelectorAll("span").forEach(span => {
        const t = span.textContent.trim();
        if (t.length > 1 && ann.text.includes(t)) span.classList.add(`ann-${ann.type}`);
      });
    });
  }, [annotations]);

  // Global mouseup: catches selection regardless of which element the drag ends on.
  useEffect(() => {
    const onUp = (e) => {
      // Ignore if the click was outside our viewer
      if (!containerRef.current?.contains(e.target)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { setToolbar(null); return; }
      const text = sel.toString().trim();
      if (!text) { setToolbar(null); return; }

      // Determine page number from the DOM tree of the selection anchor
      let pageNum = 1;
      let el = sel.anchorNode?.nodeType === 3
        ? sel.anchorNode.parentElement
        : sel.anchorNode;
      while (el) {
        if (el.dataset?.pagenum) { pageNum = parseInt(el.dataset.pagenum, 10); break; }
        el = el.parentElement;
      }

      // Store raw client coords — toolbar uses position:fixed so no scroll offset needed
      setToolbar({ cx: e.clientX, cy: e.clientY, text, page: pageNum });
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  const applyAnnotation = useCallback((type) => {
    if (!toolbar) return;
    onAnnotate({ type, text: toolbar.text, page: toolbar.page, timestamp: new Date().toISOString() });
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  }, [toolbar, onAnnotate]);

  return (
    <>
      {/* Toolbar rendered outside the scroll container, uses position:fixed */}
      <AnnToolbar
        pos={toolbar}
        onApply={applyAnnotation}
        onDismiss={() => { window.getSelection()?.removeAllRanges(); setToolbar(null); }}
      />
      <div className="pdf-viewer" ref={containerRef}>
        {pages.map(pageNum => (
          <PDFPage key={pageNum} pageNum={pageNum} onRender={renderPage} />
        ))}
      </div>
    </>
  );
}

function PDFPage({ pageNum, onRender }) {
  const canvasRef = useRef(null);
  const textRef   = useRef(null);
  useEffect(() => { onRender(pageNum, canvasRef.current, textRef.current); }, [pageNum, onRender]);
  return (
    <div className="pdf-page-wrap">
      <div className="pdf-page-num">Page {pageNum}</div>
      {/* data-pagenum lets the global mouseup handler know which page was selected */}
      <div className="pdf-page-inner" data-pagenum={pageNum}>
        <canvas ref={canvasRef} />
        <div ref={textRef} className="pdf-text-layer" />
      </div>
    </div>
  );
}

// ─── DOCX / text editor ───────────────────────────────────────────────────────

function DocEditor({ html, onChange }) {
  const editorRef = useRef(null);

  const exec = useCallback((cmd, val = null) => {
    editorRef.current?.focus();
    if (cmd === "highlight") {
      document.execCommand("hiliteColor", false, "#fff176");
    } else if (cmd === "removeHighlight") {
      document.execCommand("hiliteColor", false, "transparent");
    } else {
      document.execCommand(cmd, false, val);
    }
    editorRef.current?.focus();
  }, []);

  const handleInput = useCallback(() => {
    onChange?.(editorRef.current?.innerHTML || "");
  }, [onChange]);

  const tools = [
    { id:"bold",            label:"B",  cmd:"bold",            title:"Bold",            style:{fontWeight:800} },
    { id:"italic",          label:"I",  cmd:"italic",          title:"Italic",          style:{fontStyle:"italic"} },
    { id:"underline",       label:"U",  cmd:"underline",       title:"Underline",       style:{textDecoration:"underline"} },
    { id:"strikethrough",   label:"S",  cmd:"strikeThrough",   title:"Strikethrough",   style:{textDecoration:"line-through"} },
    { id:"highlight",       label:"H",  cmd:"highlight",       title:"Highlight",       style:{background:"#fff176"} },
  ];

  return (
    <div className="doc-editor">
      <div className="doc-toolbar">
        {tools.map(t => (
          <button key={t.id} className="doc-tool-btn" title={t.title} style={t.style}
                  onMouseDown={e => { e.preventDefault(); exec(t.cmd); }}>
            {t.label}
          </button>
        ))}
        <span className="doc-toolbar-sep" />
        <button className="doc-tool-btn" title="Copy selection"
                onMouseDown={e => { e.preventDefault(); document.execCommand("copy"); }}>
          Copy
        </button>
        <button className="doc-tool-btn" title="Paste"
                onMouseDown={e => { e.preventDefault(); exec("paste"); }}>
          Paste
        </button>
      </div>
      <div ref={editorRef} className="doc-content" contentEditable suppressContentEditableWarning
           onInput={handleInput} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ─── change log panel ─────────────────────────────────────────────────────────

function ChangeLog({ entries }) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  return (
    <div className="change-log">
      <button className="change-log-toggle" onClick={() => setOpen(o => !o)}>
        <Pencil size={13} />
        {entries.length} change{entries.length !== 1 ? "s" : ""}
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="change-log-list">
          {entries.slice().reverse().map((e, i) => (
            <div key={i} className="change-log-entry">
              <span className={`change-tag change-tag--${e.type}`}>{e.type}</span>
              <span className="change-excerpt" title={e.excerpt}>{e.excerpt}</span>
              <span className="change-time">{new Date(e.timestamp).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── code / notebook helpers ─────────────────────────────────────────────────

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g,"");
}

function highlightPython(raw) {
  // Tokenise in one pass to avoid highlighting inside strings/comments.
  const tokens = [];
  let i = 0;
  const src = raw;
  while (i < src.length) {
    // triple-quoted strings
    if (src[i]==='"'&&src[i+1]==='"'&&src[i+2]==='"') {
      const end = src.indexOf('"""', i+3); const e = end===-1?src.length:end+3;
      tokens.push({t:"str",v:src.slice(i,e)}); i=e; continue;
    }
    if (src[i]==="'"&&src[i+1]==="'"&&src[i+2]==="'") {
      const end = src.indexOf("'''", i+3); const e = end===-1?src.length:end+3;
      tokens.push({t:"str",v:src.slice(i,e)}); i=e; continue;
    }
    // single-line strings
    if (src[i]==='"'||src[i]==="'") {
      const q=src[i]; let j=i+1;
      while(j<src.length && src[j]!==q && src[j]!=="\n") { if(src[j]==="\\")j++; j++; }
      tokens.push({t:"str",v:src.slice(i,j+1)}); i=j+1; continue;
    }
    // comments
    if (src[i]==="#") {
      const end=src.indexOf("\n",i); const e=end===-1?src.length:end;
      tokens.push({t:"cmt",v:src.slice(i,e)}); i=e; continue;
    }
    // words
    if (/[A-Za-z_]/.test(src[i])) {
      let j=i; while(j<src.length&&/\w/.test(src[j]))j++;
      tokens.push({t:"word",v:src.slice(i,j)}); i=j; continue;
    }
    // numbers
    if (/\d/.test(src[i])) {
      let j=i; while(j<src.length&&/[\d.]/.test(src[j]))j++;
      tokens.push({t:"num",v:src.slice(i,j)}); i=j; continue;
    }
    // decorator
    if (src[i]==="@") {
      let j=i+1; while(j<src.length&&/\w/.test(src[j]))j++;
      tokens.push({t:"deco",v:src.slice(i,j)}); i=j; continue;
    }
    tokens.push({t:"raw",v:src[i]}); i++;
  }

  const KW  = new Set(["def","class","import","from","return","if","elif","else","for","while","in","not","and","or","is","None","True","False","pass","break","continue","try","except","finally","with","as","lambda","yield","raise","del","global","nonlocal","assert","async","await"]);
  const BLT = new Set(["print","len","range","int","str","float","list","dict","set","tuple","bool","type","isinstance","hasattr","getattr","setattr","open","enumerate","zip","map","filter","sorted","reversed","sum","min","max","abs","round","super","self"]);

  return tokens.map(tk => {
    const v = escHtml(tk.v);
    if (tk.t==="str")  return `<span class="py-str">${v}</span>`;
    if (tk.t==="cmt")  return `<span class="py-cmt">${v}</span>`;
    if (tk.t==="num")  return `<span class="py-num">${v}</span>`;
    if (tk.t==="deco") return `<span class="py-deco">${v}</span>`;
    if (tk.t==="word") {
      if (KW.has(tk.v))  return `<span class="py-kw">${v}</span>`;
      if (BLT.has(tk.v)) return `<span class="py-blt">${v}</span>`;
    }
    return v;
  }).join("");
}

function simpleMarkdown(md) {
  let h = escHtml(md);
  h = h.replace(/^#{3} (.+)$/gm,"<h3>$1</h3>")
       .replace(/^#{2} (.+)$/gm,"<h2>$1</h2>")
       .replace(/^# (.+)$/gm,"<h1>$1</h1>")
       .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
       .replace(/\*(.+?)\*/g,"<em>$1</em>")
       .replace(/`([^`]+)`/g,"<code>$1</code>")
       .replace(/^[\-\*] (.+)$/gm,"<li>$1</li>")
       .replace(/\n\n/g,"</p><p>");
  return `<p>${h}</p>`;
}

// ─── .py viewer ───────────────────────────────────────────────────────────────

function CodeViewer({ content }) {
  const html = useMemo(() => highlightPython(content), [content]);
  const copy = useCallback(() => navigator.clipboard.writeText(content).catch(()=>{}), [content]);
  const lines = content.split("\n").length;
  return (
    <div className="code-viewer">
      <div className="code-toolbar">
        <span className="code-meta">Python · {lines} line{lines!==1?"s":""}</span>
        <button className="code-copy-btn" onClick={copy}>Copy</button>
      </div>
      <pre className="code-pre" spellCheck={false}>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// ─── .ipynb viewer ────────────────────────────────────────────────────────────

function NbOutput({ output }) {
  if (output.output_type==="stream") {
    const text = (Array.isArray(output.text)?output.text.join(""):output.text)||"";
    return <pre className="nb-out-text">{stripAnsi(text)}</pre>;
  }
  if (output.output_type==="execute_result"||output.output_type==="display_data") {
    const d = output.data||{};
    if (d["image/png"])
      return <img src={`data:image/png;base64,${d["image/png"]}`} className="nb-out-img" alt="output" />;
    if (d["image/svg+xml"]) {
      const svg = Array.isArray(d["image/svg+xml"])?d["image/svg+xml"].join(""):d["image/svg+xml"];
      return <div className="nb-out-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
    }
    if (d["text/html"]) {
      const html = Array.isArray(d["text/html"])?d["text/html"].join(""):d["text/html"];
      return <div className="nb-out-html" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    if (d["text/plain"]) {
      const text = Array.isArray(d["text/plain"])?d["text/plain"].join(""):d["text/plain"];
      return <pre className="nb-out-text">{stripAnsi(text)}</pre>;
    }
  }
  if (output.output_type==="error") {
    const tb = (Array.isArray(output.traceback)?output.traceback.join("\n"):output.traceback)||"";
    return <pre className="nb-out-err">{stripAnsi(tb)}</pre>;
  }
  return null;
}

function NotebookViewer({ content }) {
  const { cells, parseError } = useMemo(() => {
    try {
      const nb = JSON.parse(content);
      // Support both nbformat v4 (nb.cells) and v3 (nb.worksheets[0].cells)
      const rawCells = nb.cells
        ?? nb.worksheets?.[0]?.cells
        ?? [];
      if (!Array.isArray(rawCells) || rawCells.length === 0) {
        return { cells: [], parseError: "No cells found in this notebook." };
      }
      return {
        cells: rawCells.map((c, i) => ({
          id: i,
          // normalise: trim + lowercase so "Code" / " code" still match
          type: String(c.cell_type ?? "raw").trim().toLowerCase(),
          src:  Array.isArray(c.source) ? c.source.join("") : String(c.source ?? ""),
          outputs: c.outputs ?? [],
          n: c.execution_count,
        })),
        parseError: null,
      };
    } catch (e) {
      return { cells: [], parseError: `Could not parse notebook JSON: ${e.message}` };
    }
  }, [content]);

  if (parseError) {
    return (
      <div className="nb-viewer">
        <div className="nb-parse-error">{parseError}</div>
        <pre className="nb-raw-fallback">{content}</pre>
      </div>
    );
  }

  return (
    <div className="nb-viewer">
      {cells.map(cell => {
        if (cell.type==="code") {
          let html;
          try { html = highlightPython(cell.src); }
          catch { html = escHtml(cell.src); }
          const lines = cell.src.split("\n");
          return (
            <div key={cell.id} className="nb-cell nb-cell--code">
              <div className="nb-gutter">
                <span className="nb-prompt">In [{cell.n ?? " "}]:</span>
                <div className="nb-line-nums">
                  {lines.map((_,li) => <span key={li}>{li+1}</span>)}
                </div>
              </div>
              <div className="nb-body">
                <pre className="nb-code"><code dangerouslySetInnerHTML={{ __html: html || escHtml(cell.src) || " " }} /></pre>
                {cell.outputs.length > 0 && (
                  <div className="nb-outputs">
                    <span className="nb-prompt nb-prompt--out">Out [{cell.n ?? ""}]:</span>
                    {cell.outputs.map((o,i) => <NbOutput key={i} output={o} />)}
                  </div>
                )}
              </div>
            </div>
          );
        }
        if (cell.type==="markdown") {
          return (
            <div key={cell.id} className="nb-cell nb-cell--md">
              <div className="nb-md-content" dangerouslySetInnerHTML={{ __html: simpleMarkdown(cell.src) }} />
            </div>
          );
        }
        return (
          <div key={cell.id} className="nb-cell nb-cell--raw">
            <pre className="nb-raw">{cell.src}</pre>
          </div>
        );
      })}
    </div>
  );
}

// ─── PPTX slide viewer (text-only cards) ─────────────────────────────────────

function PPTXSlideViewer({ slides }) {
  if (!slides?.length) return <div className="pptx-empty-state">No slide content extracted.</div>;
  return (
    <div className="pptx-viewer">
      {slides.map(slide => (
        <div key={slide.index} className="pptx-slide">
          <div className="pptx-slide-num">Slide {slide.index}</div>
          <div className="pptx-slide-body">
            {slide.text
              ? slide.text.split("\n").map((line, i) => <p key={i}>{line}</p>)
              : <em className="pptx-slide-empty">Empty slide</em>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Execution dashboard ──────────────────────────────────────────────────────

function ExecDashboard({ onClose }) {
  const [logs,     setLogs]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState({});

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/logs?limit=30`);
      if (res.ok) setLogs(await res.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLogs();
    const t = setInterval(fetchLogs, 5000);
    return () => clearInterval(t);
  }, [fetchLogs]);

  return (
    <div className="exec-dashboard">
      <div className="exec-dash-header">
        <span className="exec-dash-title"><Activity size={15}/> Execution Log</span>
        <div className="exec-dash-actions">
          <button className="exec-dash-btn" onClick={fetchLogs} title="Refresh"><RefreshCw size={13}/></button>
          <button className="exec-dash-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>
      <div className="exec-dash-body">
        {loading && <div className="exec-dash-info">Loading…</div>}
        {!loading && !logs.length && (
          <div className="exec-dash-info">
            No executions recorded yet. Run a workflow via the backend to see logs here.<br/>
            <small>Backend must be running: <code>cd workflow-engine &amp;&amp; node server.js</code></small>
          </div>
        )}
        {logs.map((log, i) => (
          <div key={i} className={`exec-log-row exec-log-row--${log.status}`}>
            <div className="exec-log-summary"
                 onClick={() => setExpanded(p => ({ ...p, [i]: !p[i] }))}>
              <span className={`exec-dot exec-dot--${log.status}`} />
              <span className="exec-wf-name" title={log.workflowId}>{log.workflowName || log.workflowId}</span>
              <span className="exec-meta">{log.duration != null ? `${log.duration}ms` : ""}</span>
              <span className="exec-meta">{new Date(log.startedAt).toLocaleString()}</span>
              {expanded[i] ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}
            </div>
            {expanded[i] && (
              <div className="exec-steps-list">
                {(log.steps || []).map((step, j) => (
                  <div key={j} className={`exec-step exec-step--${step.status}`}>
                    <span className="exec-step-label">{step.label || step.nodeType}</span>
                    <span className="exec-step-dur">{step.duration}ms</span>
                    {step.attempts > 1 && <span className="exec-step-retries">↺ {step.attempts} attempts</span>}
                    {step.error && <span className="exec-step-err" title={step.error}>{step.error.slice(0, 80)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── AI suggest overlay ───────────────────────────────────────────────────────

function AISuggestPanel({ result, onAddTool, onClose }) {
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div className="ai-panel" onClick={e => e.stopPropagation()}>
        <div className="ai-panel-header">
          <span><Sparkles size={15}/> AI Workflow Suggestion</span>
          <button className="ai-close-btn" onClick={onClose}>✕</button>
        </div>
        {result.loading && <div className="ai-loading"><RefreshCw size={16}/> Analysing your folder…</div>}
        {result.error && (
          <div className="ai-error">
            <p>{result.error}</p>
            {result.hint && <p className="ai-hint">{result.hint}</p>}
          </div>
        )}
        {!result.loading && !result.error && (
          <>
            {result.analysis && <p className="ai-analysis">{result.analysis}</p>}
            <div className="ai-suggestions">
              {(result.suggestions || []).map((s, i) => (
                <div key={i} className="ai-suggestion-item">
                  <div className="ai-suggestion-name">{s.tool}</div>
                  <div className="ai-suggestion-reason">{s.reason}</div>
                  <button className="ai-add-btn" onClick={() => onAddTool(s.toolId)}>
                    + Add to canvas
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── file viewer window ───────────────────────────────────────────────────────

function FileViewerWindow({ file, changeLog, onClose, onAnnotationAdded, height }) {
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pdfBuf,    setPdfBuf]    = useState(null);
  const [docHtml,   setDocHtml]   = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const prevFileRef = useRef(null);

  useEffect(() => {
    if (!file || file === prevFileRef.current) return;
    prevFileRef.current = file;
    setAnnotations([]);
    setLoading(true);
    setPdfBuf(null);
    setDocHtml(null);

    (async () => {
      const ext = file.ext;
      if (ext === ".pdf") {
        if (file.blobUrl) {
          const res = await fetch(file.blobUrl);
          setPdfBuf(await res.arrayBuffer());
        }
      } else if (ext === ".docx" || ext === ".doc") {
        if (file.html) setDocHtml(file.html);
      }
      // code / notebook — content already in file object, nothing async needed
      setLoading(false);
    })();
  }, [file]);

  const handlePDFAnnotate = useCallback((ann) => {
    setAnnotations(prev => [...prev, ann]);
    onAnnotationAdded?.({
      type: ann.type, excerpt: ann.text.slice(0, 60) + (ann.text.length > 60 ? "…" : ""),
      timestamp: ann.timestamp, fileName: file.name,
    });
  }, [file, onAnnotationAdded]);

  const handleDocChange = useCallback((newHtml) => {
    const ts = new Date().toISOString();
    onAnnotationAdded?.({
      type: "edit", excerpt: "Document content changed",
      timestamp: ts, fileName: file.name,
    });
  }, [file, onAnnotationAdded]);

  const handleDocAnnotate = useCallback((type) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    onAnnotationAdded?.({
      type, excerpt: text.slice(0, 60) + (text.length > 60 ? "…" : ""),
      timestamp: new Date().toISOString(), fileName: file.name,
    });
  }, [file, onAnnotationAdded]);

  if (!file) return null;
  const extLabel = file.ext?.replace(".", "").toUpperCase() ?? "";
  const entries  = changeLog || [];

  return (
    <div
      className={`preview-window${minimized?" preview-window--minimized":""}${maximized?" preview-window--maximized":""}`}
      style={!maximized && !minimized && height ? { height } : {}}
    >
      <div className="preview-titlebar">
        <div className="preview-traffic">
          <button className="preview-btn preview-close"    onClick={onClose}                       title="Close"    aria-label="Close" />
          <button className="preview-btn preview-minimize" onClick={() => setMinimized(m => !m)}   title={minimized?"Restore":"Minimize"} aria-label="Minimize" />
          <button className="preview-btn preview-maximize" onClick={() => setMaximized(m => !m)}   title={maximized?"Restore":"Maximize"} aria-label="Maximize" />
        </div>
        <span className="preview-filename" title={file.name}>{file.name}</span>
        {extLabel && <span className="preview-type-badge">{extLabel}</span>}
        {entries.length > 0 && <span className="preview-edit-badge">{entries.length} edit{entries.length!==1?"s":""}</span>}
      </div>

      {!minimized && (
        <div className="preview-content">
          {loading && <div className="preview-loading">Loading…</div>}

          {!loading && file.type === "image" && (
            <div className="preview-image-wrap">
              <img src={file.blobUrl} alt={file.name} className="preview-image" draggable={false} />
            </div>
          )}

          {!loading && pdfBuf && (
            <PDFAnnotationViewer
              arrayBuffer={pdfBuf}
              annotations={annotations}
              onAnnotate={handlePDFAnnotate}
            />
          )}

          {!loading && docHtml !== null && (
            <DocEditor html={docHtml} onChange={handleDocChange} />
          )}

          {!loading && file.type === "code" && (
            <CodeViewer content={file.content} />
          )}

          {!loading && file.type === "notebook" && (
            <NotebookViewer content={file.content} />
          )}

          {!loading && file.type === "pptx" && (
            <PPTXSlideViewer slides={file.slides} />
          )}

          {!loading && !pdfBuf && docHtml === null && file.type === "unsupported" && (
            <div className="preview-unsupported">
              <FileText size={52} />
              <p>Inline preview not available for <strong>{extLabel}</strong> files.</p>
              <a href={file.blobUrl} download={file.name} className="preview-download-btn">
                <Download size={15} /> Download to open
              </a>
            </div>
          )}

          <ChangeLog entries={entries} />
        </div>
      )}
    </div>
  );
}

// ─── Rich output viewer ───────────────────────────────────────────────────────

function MarkdownTable({ rows }) {
  const dataRows = rows.filter(r => !/^\s*\|[\s|:-]+\|\s*$/.test(r));
  const parsed   = dataRows.map(r => r.split("|").slice(1, -1).map(c => c.trim()));
  if (!parsed.length) return null;
  const [header, ...body] = parsed;
  return (
    <div className="py-out-table-wrap">
      <table className="py-out-table">
        <thead><tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{body.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function OutputViewer({ text, isError }) {
  if (!text) return null;

  // Try JSON
  const trimmed = text.trim();
  if (!isError && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed = JSON.parse(trimmed);
      return <pre className="py-out py-out--json">{JSON.stringify(parsed, null, 2)}</pre>;
    } catch {}
  }

  // Detect markdown table sections
  const lines = text.split("\n");
  const tableStart = lines.findIndex(l => /^\s*\|.+\|/.test(l));
  if (!isError && tableStart >= 0) {
    const tableLines = [];
    for (let i = tableStart; i < lines.length && /^\s*\|/.test(lines[i]); i++) tableLines.push(lines[i]);
    if (tableLines.length >= 2) {
      const pre  = lines.slice(0, tableStart).join("\n");
      const post = lines.slice(tableStart + tableLines.length).join("\n");
      return (
        <div className="py-out-rich">
          {pre.trim()  && <pre className="py-out">{pre}</pre>}
          <MarkdownTable rows={tableLines} />
          {post.trim() && <pre className="py-out">{post}</pre>}
        </div>
      );
    }
  }

  return <pre className={`py-out${isError ? " py-out--err" : ""}`}>{text}</pre>;
}

// ─── Output display panel ─────────────────────────────────────────────────────

// Reads a file's current on-disk state via its FileSystemFileHandle and
// extracts all output cells from a Jupyter notebook or returns image files.
// Cleans stream text: removes ANSI codes, strips carriage-return overwrite sequences
// (tqdm writes lines using \r — take only the LAST segment before \n on each CR-line)
function cleanStreamText(raw) {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[mKJHABCDfhilmnoprsulz]/g, "") // ANSI escape codes
    .split("\n")
    .map(line => {
      // Each line may have CR overwrite segments: take the last segment
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n")
    .trimEnd();
  return cleaned;
}

async function readIDEOutputs(fileEntry, workflowFiles = [], folderName = "", onStatus) {
  let file;
  try {
    if (fileEntry.handle)          file = await fileEntry.handle.getFile();
    else if (fileEntry.fileObject) file = fileEntry.fileObject;
    else return { error: "File handle unavailable — re-scan the folder." };
  } catch {
    return { error: "Permission expired. Re-scan the folder to refresh access." };
  }

  const ext = extensionOf(file.name);

  if (ext === ".ipynb") {
    try {
      const text = await file.text();
      const nb   = JSON.parse(text);
      const rawCells = nb.cells ?? nb.worksheets?.[0]?.cells ?? [];
      const items  = [];
      let cellsWithOutput = 0;
      let cellIdx  = 0;
      for (const cell of rawCells) {
        const type = String(cell.cell_type ?? "").trim().toLowerCase();
        if (type !== "code") continue;
        cellIdx++;
        const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
        const outputs = cell.outputs ?? [];
        if (!outputs.length) continue;
        cellsWithOutput++;

        for (const out of outputs) {
          const d = out.data ?? {};

          if (d["image/png"]) {
            // Join array chunks + strip all whitespace (newlines, spaces) for valid data URL
            const raw = Array.isArray(d["image/png"]) ? d["image/png"].join("") : d["image/png"];
            const b64 = raw.replace(/\s/g, "");
            items.push({ kind: "image", b64, cellIdx, src: src.slice(0, 120) });

          } else if (d["image/svg+xml"]) {
            const svg = Array.isArray(d["image/svg+xml"]) ? d["image/svg+xml"].join("") : d["image/svg+xml"];
            items.push({ kind: "svg", svg, cellIdx, src: src.slice(0, 120) });

          } else if (d["text/html"]) {
            const html = Array.isArray(d["text/html"]) ? d["text/html"].join("") : d["text/html"];
            items.push({ kind: "html", html, cellIdx, src: src.slice(0, 120) });

          } else if (out.output_type === "stream" && out.text) {
            // Stream outputs (stdout/stderr) — clean CR/ANSI before display
            const raw = Array.isArray(out.text) ? out.text.join("") : String(out.text);
            const txt = cleanStreamText(raw);
            if (txt.trim()) items.push({ kind: "text", text: txt, cellIdx, src: src.slice(0, 120) });

          } else if (d["text/plain"]) {
            const raw = Array.isArray(d["text/plain"]) ? d["text/plain"].join("") : d["text/plain"];
            // Skip <Figure ...> placeholder text — not useful output
            if (raw.trim() && !raw.trim().startsWith("<Figure")) {
              items.push({ kind: "text", text: raw, cellIdx, src: src.slice(0, 120) });
            }

          } else if (out.output_type === "error") {
            const tb = (Array.isArray(out.traceback) ? out.traceback.join("\n") : out.traceback) || out.evalue || "";
            const cleaned = cleanStreamText(tb);
            if (cleaned.trim()) items.push({ kind: "error", text: cleaned, cellIdx, src: src.slice(0, 120) });
          }
        }
      }
      // Group flat items back into cells for display
      const cells = [];
      let currentCell = null;
      for (const item of items) {
        if (!currentCell || currentCell.cellIdx !== item.cellIdx) {
          currentCell = { cellIdx: item.cellIdx, src: item.src, outputs: [] };
          cells.push(currentCell);
        }
        currentCell.outputs.push(item);
      }

      const savedAt = file.lastModified ? new Date(file.lastModified).toLocaleString() : "unknown";
      return { kind: "notebook", cells, name: file.name, savedAt, totalCells: cellsWithOutput };
    } catch (e) {
      return { error: `Could not parse notebook: ${e.message}` };
    }
  }

  if (ext === ".py") {
    try {
      onStatus?.("Reading Python script…");
      const extracted = await extractTextContent(fileEntry, 512 * 1024);
      if (!extracted?.content) return { error: "Could not read this Python file. Re-scan the folder and try again." };

      onStatus?.("Loading project files into browser runtime…");
      const runFiles = await enrichFilesForPythonRun(workflowFiles, folderName);
      const startedAt = Date.now();
      const result = await runPythonBrowser(
        extracted.content,
        runFiles,
        onStatus,
        workflowRelativePath(fileEntry, folderName) || file.name
      );

      const outputs = [];
      if (result.stdout?.trim()) outputs.push({ kind: "text", text: cleanStreamText(result.stdout), cellIdx: 1, src: file.name });
      for (const b64 of result.figures || []) outputs.push({ kind: "image", b64, cellIdx: 1, src: file.name });
      for (const artifact of result.artifacts || []) {
        if (artifact.kind === "image") outputs.push({ kind: "image", b64: artifact.b64, cellIdx: 1, src: artifact.name });
        else if (artifact.kind === "svg") outputs.push({ kind: "svg", svg: artifact.svg, cellIdx: 1, src: artifact.name });
        else if (artifact.kind === "text") outputs.push({ kind: "text", text: `Generated file: ${artifact.name}\n\n${artifact.text}`, cellIdx: 1, src: artifact.name });
        else outputs.push({ kind: "text", text: `Generated file: ${artifact.name} (${formatBytes(artifact.size)})`, cellIdx: 1, src: artifact.name });
      }
      if (result.stderr?.trim()) outputs.push({ kind: "error", text: cleanStreamText(result.stderr), cellIdx: 1, src: file.name });

      return {
        kind: "script",
        cells: outputs.length ? [{ cellIdx: 1, src: file.name, outputs }] : [],
        name: file.name,
        savedAt: file.lastModified ? new Date(file.lastModified).toLocaleString() : "unknown",
        success: result.success,
        duration: Date.now() - startedAt,
        truncated: !!extracted.truncated,
      };
    } catch (e) {
      return { error: `Could not run Python script in browser: ${e.message}` };
    }
  }

  // For standalone image files (.png, .jpg, .svg, etc.)
  if (IMAGE_EXTS.has(ext) || ext === ".svg") {
    try {
      const blob = new Blob([await file.arrayBuffer()], { type: file.type || "image/png" });
      const url  = URL.createObjectURL(blob);
      return { kind: "image-file", url, name: file.name, savedAt: file.lastModified ? new Date(file.lastModified).toLocaleString() : "" };
    } catch (e) {
      return { error: e.message };
    }
  }

  return { error: `Unsupported file type for output scanning: ${ext}` };
}

function OutputDisplayPanel({ workflowId, lastOutput, workflow, onClose }) {
  const [tab,      setTab]      = useState("ide");   // "ide" | "browser"
  const [picked,   setPicked]   = useState(null);    // file name string
  const [ideOut,   setIdeOut]   = useState(null);    // result from readIDEOutputs
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(null);
  const [autoTimer, setAutoTimer] = useState(null);  // interval id for auto-refresh
  const [expanded, setExpanded] = useState(false);   // ↔ expand toggle
  const [zoomedImg, setZoomedImg] = useState(null);  // base64 or null — full-screen plot view
  const scrollRef = useRef(null);

  const scrollBy = (px) => scrollRef.current?.scrollBy({ top: px, behavior: "smooth" });

  // When this panel unmounts (user clicks ✕ on parent), free the notebook
  // outputs — each base64 PNG is ~150 KB and 18-cell notebooks can hold ~3 MB.
  useEffect(() => () => {
    setIdeOut(null);
    setPicked(null);
    setZoomedImg(null);
    if (autoTimer) clearInterval(autoTimer);
  }, []); // empty deps → cleanup runs only on unmount

  // Close lightbox on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && zoomedImg) setZoomedImg(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomedImg]);

  const browserOut = lastOutput?.[workflowId];

  // Files that can produce IDE outputs
  const outputFiles = useMemo(() => {
    const files = workflow?.files ?? [];
    const nb  = files.filter(f => extensionOf(f.name) === ".ipynb");
    const py  = files.filter(f => extensionOf(f.name) === ".py");
    const img = files.filter(f => IMAGE_EXTS.has(extensionOf(f.name)) || extensionOf(f.name) === ".svg");
    return { nb, py, img };
  }, [workflow?.files]);

  const handleScan = useCallback(async (fileEntry) => {
    setPicked(fileEntry.name);
    setScanning(true);
    setScanStatus("Reading file from disk…");
    setIdeOut(null);
    setZoomedImg(null);   // free any open lightbox image from previous file
    const result = await readIDEOutputs(fileEntry, workflow?.files ?? [], workflow?.folderName ?? "", setScanStatus);
    setIdeOut(result);
    // Start with ALL cells expanded so plots are immediately visible
    if (result?.cells?.length) {
      setExpandedCells(new Set(result.cells.map(c => c.cellIdx)));
    } else {
      setExpandedCells(new Set());
    }
    setScanStatus(null);
    setScanning(false);
  }, [workflow?.files, workflow?.folderName]);

  // Auto-refresh: re-scan on a 5-second interval while panel is open
  const toggleAutoRefresh = useCallback((fileEntry) => {
    if (autoTimer) { clearInterval(autoTimer); setAutoTimer(null); return; }
    const t = setInterval(() => handleScan(fileEntry), 5000);
    setAutoTimer(t);
  }, [autoTimer, handleScan]);

  useEffect(() => () => { if (autoTimer) clearInterval(autoTimer); }, [autoTimer]);

  // Track which cells are expanded — default: all collapsed, click to open
  const [expandedCells, setExpandedCells] = useState(new Set());
  const toggleCell = useCallback((idx) => {
    setExpandedCells(prev => {
      const s = new Set(prev);
      s.has(idx) ? s.delete(idx) : s.add(idx);
      return s;
    });
  }, []);

  const renderOutput = (item) => {
    if (item.kind === "image") return (
      <div key="img" className="odp-figure-wrap" title="Click to enlarge" onClick={() => setZoomedImg(item.b64)}>
        <img src={`data:image/png;base64,${item.b64}`} className="odp-figure"
             alt={`Figure from cell ${item.cellIdx}`}
             onError={e => { e.target.parentElement.style.display="none"; }} />
        <span className="odp-zoom-hint">🔍 click to enlarge</span>
      </div>
    );
    if (item.kind === "svg")   return <div key="svg" className="odp-svg" onClick={() => setZoomedImg("svg:" + item.svg)} style={{cursor:"zoom-in"}} title="Click to enlarge" dangerouslySetInnerHTML={{ __html: item.svg }} />;
    if (item.kind === "html")  return <div key="html" className="odp-html" dangerouslySetInnerHTML={{ __html: item.html }} />;
    if (item.kind === "text")  return <pre key="txt" className="odp-text">{item.text}</pre>;
    if (item.kind === "error") return <pre key="err" className="odp-error-pre">{item.text}</pre>;
    return null;
  };

  const renderIdeOutputs = () => {
    if (scanning) return <div className="odp-empty">{scanStatus || "Reading file from disk…"}</div>;
    if (!picked)  return (
      <div className="odp-empty">
        <BarChart3 size={36} strokeWidth={1.2}/>
        <p>Select a notebook, script, or image from the list.</p>
        <small>Notebook outputs are read from saved .ipynb files. Python scripts run in-browser and show captured stdout, errors, and plots.</small>
      </div>
    );
    if (!ideOut)  return null;
    if (ideOut.error) return <div className="odp-error">{ideOut.error}</div>;

    if (ideOut.kind === "notebook" || ideOut.kind === "script") {
      const { cells = [] } = ideOut;
      const isScript = ideOut.kind === "script";
      return (
        <>
          <div className="odp-meta">
            {ideOut.name} &nbsp;·&nbsp; {isScript ? "browser run" : `saved ${ideOut.savedAt}`} &nbsp;·&nbsp;
            {isScript ? (
              <>
                <strong>{ideOut.success ? "OK" : "Error"}</strong>
                {ideOut.duration != null && <> &nbsp;·&nbsp; {ideOut.duration}ms</>}
                {ideOut.truncated && <> &nbsp;·&nbsp; source truncated</>}
              </>
            ) : (
              <><strong>{ideOut.totalCells}</strong> cell{ideOut.totalCells !== 1 ? "s" : ""} with output</>
            )}
            {cells.length > 0 && <span className="odp-toggle-all">
              <button className="odp-toggle-all-btn" onClick={() => setExpandedCells(new Set(cells.map(c => c.cellIdx)))}>Expand all</button>
              <button className="odp-toggle-all-btn" onClick={() => setExpandedCells(new Set())}>Collapse all</button>
            </span>}
          </div>

          {cells.length === 0 && (
            <div className="odp-empty">
              <p>{isScript ? "Script completed with no visible output." : "No output cells found in this notebook yet."}</p>
              <small>{isScript ? "Use print(...), plt.show(), or plt.savefig(...) to produce displayable output." : "Run the notebook in VS Code or JupyterLab, save it, then click Rescan."}</small>
            </div>
          )}

          {cells.map(cell => {
            const isOpen  = expandedCells.has(cell.cellIdx);
            const hasPlot = cell.outputs.some(o => o.kind === "image" || o.kind === "svg");
            return (
              <div key={cell.cellIdx} className="odp-cell-block">
                {/* Cell header — click to open/close outputs */}
                <div className="odp-cell-header" onClick={() => toggleCell(cell.cellIdx)}>
                  <span className="odp-cell-num">{isScript ? "Run" : `Cell ${cell.cellIdx}`}</span>
                  {hasPlot && <span className="odp-plot-badge">📊 plot</span>}
                  <code className="odp-cell-src">{cell.src.slice(0, 80)}{cell.src.length > 80 ? "…" : ""}</code>
                  <span className="odp-cell-chevron">{isOpen ? "▼" : "▶"}</span>
                </div>
                {isOpen && (
                  <div className="odp-cell-outputs">
                    {cell.outputs.map((item, j) => (
                      <div key={j} className={`odp-output-item odp-output-item--${item.kind}`}>
                        {renderOutput(item)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      );
    }

    if (ideOut.kind === "image-file") {
      return (
        <>
          <div className="odp-meta">{ideOut.name} &nbsp;·&nbsp; {ideOut.savedAt}</div>
          <img src={ideOut.url} className="odp-figure" alt={ideOut.name} />
        </>
      );
    }
    return null;
  };

  return (
    <div className={`output-display-panel${expanded ? " output-display-panel--expanded" : ""}`}>
      <div className="output-display-header">
        <span><BarChart3 size={15}/> Output Display</span>
        <div className="odp-tabs">
          <button className={`odp-tab${tab === "ide" ? " active" : ""}`} onClick={() => setTab("ide")}>
            From IDE run
          </button>
          <button className={`odp-tab${tab === "browser" ? " active" : ""}`} onClick={() => setTab("browser")}>
            From browser
          </button>
        </div>
        <button className="odp-expand-btn" onClick={() => setExpanded(e => !e)}
                title={expanded ? "Collapse panel" : "Expand panel"}>
          {expanded ? "⊡" : "⤢"}
        </button>
        <button className="output-display-close" onClick={onClose}>✕</button>
      </div>

      {/* ── IDE Outputs tab ───────────────────────────────────────────────── */}
      {tab === "ide" && (
        <div className="odp-ide-layout">
          <div className="odp-sidebar">
            {outputFiles.nb.length > 0 && <>
              <div className="odp-sidebar-head">Notebooks</div>
              {outputFiles.nb.map(f => (
                <div key={f.path} className={`odp-file-item${picked === f.name ? " active" : ""}`}
                     onClick={() => handleScan(f)} title={f.path}>
                  📓 {f.name}
                </div>
              ))}
            </>}
            {outputFiles.py.length > 0 && <>
              <div className="odp-sidebar-head">Scripts</div>
              {outputFiles.py.map(f => (
                <div key={f.path} className={`odp-file-item${picked === f.name ? " active" : ""}`}
                     onClick={() => handleScan(f)} title={f.path}>
                  🐍 {f.name}
                </div>
              ))}
            </>}
            {outputFiles.img.length > 0 && <>
              <div className="odp-sidebar-head">Images ({outputFiles.img.length})</div>
              {outputFiles.img.slice(0, 20).map(f => (
                <div key={f.path} className={`odp-file-item${picked === f.name ? " active" : ""}`}
                     onClick={() => handleScan(f)} title={f.path}>
                  🖼 {f.name}
                </div>
              ))}
            </>}
            {outputFiles.nb.length === 0 && outputFiles.py.length === 0 && outputFiles.img.length === 0 && (
              <p className="odp-sidebar-empty">No Python or notebook files found in this folder.</p>
            )}
          </div>

          <div className="odp-content">
            {/* Toolbar — always in the DOM when a file is picked, never inside the scroll area */}
            {picked && (
              <div className="odp-toolbar">
                <button className="odp-rescan-btn" onClick={() => {
                  const f = [...outputFiles.nb, ...outputFiles.py, ...outputFiles.img].find(x => x.name === picked);
                  if (f) handleScan(f);
                }} disabled={scanning}>↺ Rescan</button>
                <button className={`odp-auto-btn${autoTimer ? " active" : ""}`} onClick={() => {
                  const f = [...outputFiles.nb, ...outputFiles.py, ...outputFiles.img].find(x => x.name === picked);
                  if (f) toggleAutoRefresh(f);
                }}>
                  {autoTimer ? "⏸ Stop auto" : "▶ Auto-refresh (5s)"}
                </button>
                {autoTimer && <span className="odp-live-badge">LIVE</span>}
                {/* Scroll buttons in the toolbar — always visible, never clipped */}
                {ideOut && !ideOut.error && (
                  <div className="odp-scroll-btns-inline">
                    <button className="odp-scroll-btn-inline" onClick={() => scrollRef.current?.scrollBy({ top: -300, behavior: "smooth" })} title="Scroll up">▲</button>
                    <button className="odp-scroll-btn-inline" onClick={() => scrollRef.current?.scrollBy({ top: 300,  behavior: "smooth" })} title="Scroll down">▼</button>
                  </div>
                )}
              </div>
            )}
            <div className="odp-scroll" ref={scrollRef}>{renderIdeOutputs()}</div>
          </div>
        </div>
      )}

      {/* ── Full-screen plot zoom overlay ────────────────────────────────── */}
      {zoomedImg && (
        <div className="odp-zoom-overlay" onClick={() => setZoomedImg(null)}>
          <button className="odp-zoom-close" onClick={() => setZoomedImg(null)}>✕ Close</button>
          {zoomedImg.startsWith("svg:") ? (
            <div className="odp-zoom-svg" dangerouslySetInnerHTML={{ __html: zoomedImg.slice(4) }} />
          ) : (
            <img src={`data:image/png;base64,${zoomedImg}`} className="odp-zoom-img" alt="Full-size plot"
                 onClick={e => e.stopPropagation()} />
          )}
        </div>
      )}

      {/* ── Browser Run tab ───────────────────────────────────────────────── */}
      {tab === "browser" && (
        <div className="output-display-body">
          {!browserOut && (
            <div className="output-display-empty">
              <BarChart3 size={32} strokeWidth={1.4}/>
              <p>No browser run yet.</p>
              <small>Use the Pyodide runner inside the Python Analysis Step to see output here.</small>
            </div>
          )}
          {browserOut && (
            <>
              <div className="output-display-meta">
                {new Date(browserOut.timestamp).toLocaleString()} &nbsp;·&nbsp;
                {browserOut.success ? "✓ OK" : "✗ Error"}
                {browserOut.duration != null && <> &nbsp;·&nbsp; {browserOut.duration}ms</>}
              </div>
              {browserOut.stdout && <OutputViewer text={browserOut.stdout} />}
              {browserOut.figures?.length > 0 && (
                <div className="py-figures">
                  {browserOut.figures.map((fig, i) => (
                    <img key={i} src={`data:image/png;base64,${fig}`} className="py-figure" alt={`Figure ${i + 1}`} />
                  ))}
                </div>
              )}
              {browserOut.stderr && <OutputViewer text={browserOut.stderr} isError />}
              {!browserOut.stdout && !browserOut.stderr && !browserOut.figures?.length && (
                <div className="output-display-empty"><small>Script completed with no output.</small></div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared tool panel shell ──────────────────────────────────────────────────

function ToolShell({ title, IconComponent, onClose, children, headerRight }) {
  return (
    <div className="tool-panel">
      <div className="tool-panel-header">
        <span className="tool-panel-title"><IconComponent size={15}/> {title}</span>
        <div className="tool-panel-hright">{headerRight}<button className="tool-panel-close" onClick={onClose}>✕</button></div>
      </div>
      <div className="tool-panel-body">{children}</div>
    </div>
  );
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSVText(text, maxRows = 200) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const parseRow = (line) => {
    const cells = []; let cell = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === "," && !inQ) { cells.push(cell.trim()); cell = ""; }
      else cell += line[i];
    }
    cells.push(cell.trim());
    return cells;
  };
  const headers = parseRow(lines[0]);
  const rows = lines.slice(1, maxRows + 1).map(l => {
    const cells = parseRow(l);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
  return { headers, rows };
}

function csvStats(headers, rows) {
  return headers.map(h => {
    const vals = rows.map(r => r[h]).filter(v => v !== "" && v != null);
    const nums = vals.map(Number).filter(v => !isNaN(v));
    const missing = rows.length - vals.length;
    if (nums.length > vals.length * 0.5) {
      const min = Math.min(...nums), max = Math.max(...nums);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { col: h, type: "numeric", count: vals.length, missing, min: min.toFixed(2), max: max.toFixed(2), mean: mean.toFixed(2) };
    }
    const unique = new Set(vals).size;
    return { col: h, type: "text", count: vals.length, missing, unique, sample: vals.slice(0, 3).join(", ") };
  });
}

// ─── Document Extractor panel ─────────────────────────────────────────────────

function DocumentExtractorPanel({ workflow, onClose }) {
  const DOC_EXTS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".rtf"]);
  const files = useMemo(() => (workflow?.files ?? []).filter(f => DOC_EXTS.has(extensionOf(f.name))), [workflow?.files]);
  const [selected, setSelected] = useState(new Set());
  const [results,  setResults]  = useState([]); // [{name, text, words, truncated}]
  const [loading,  setLoading]  = useState(false);

  const toggleAll = () => setSelected(selected.size === files.length ? new Set() : new Set(files.map(f => f.path)));

  const handleExtract = useCallback(async () => {
    setLoading(true); setResults([]);
    const out = [];
    for (const f of files.filter(f => selected.has(f.path))) {
      const x = await extractTextContent(f);
      if (x?.content) out.push({ name: f.name, text: x.content, words: x.content.split(/\s+/).length, truncated: !!x.truncated });
      else out.push({ name: f.name, text: null, words: 0, truncated: false });
    }
    setResults(out); setLoading(false);
  }, [files, selected]);

  const copyAll = () => {
    const text = results.filter(r => r.text).map(r => `=== ${r.name} ===\n${r.text}`).join("\n\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <ToolShell title="Document Extractor" IconComponent={FileText} onClose={onClose}
      headerRight={results.length > 0 && <button className="tool-hbtn" onClick={copyAll}>Copy all</button>}>
      {files.length === 0 ? (
        <p className="tool-empty">No document files found (PDF, DOCX, TXT, MD) in this folder.</p>
      ) : (
        <div className="tool-two-col">
          <div className="tool-left">
            <div className="tool-section-head">
              <span>{files.length} documents</span>
              <button className="tool-sm-btn" onClick={toggleAll}>{selected.size === files.length ? "Deselect all" : "Select all"}</button>
            </div>
            <div className="tool-file-list">
              {files.map(f => (
                <label key={f.path} className="tool-file-check">
                  <input type="checkbox" checked={selected.has(f.path)} onChange={() => {
                    const s = new Set(selected);
                    s.has(f.path) ? s.delete(f.path) : s.add(f.path);
                    setSelected(s);
                  }} />
                  <span title={f.path}>{f.name}</span>
                </label>
              ))}
            </div>
            <button className="tool-run-btn" disabled={!selected.size || loading} onClick={handleExtract}>
              {loading ? "Extracting…" : `Extract ${selected.size || ""} file${selected.size !== 1 ? "s" : ""}`}
            </button>
          </div>
          <div className="tool-right">
            {results.length === 0 && !loading && <p className="tool-empty">Select files and click Extract.</p>}
            {loading && <p className="tool-empty">Extracting text…</p>}
            {results.map((r, i) => (
              <div key={i} className="tool-extract-block">
                <div className="tool-extract-name">{r.name} {r.text && <span>· {r.words.toLocaleString()} words{r.truncated ? " (truncated)" : ""}</span>}</div>
                {r.text ? <pre className="tool-extract-text">{r.text}</pre> : <p className="tool-extract-err">Could not extract text from this file.</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ─── Table / CSV Analyzer panel ───────────────────────────────────────────────

function CSVAnalyzerPanel({ workflow, onClose }) {
  const CSV_EXTS = new Set([".csv", ".tsv"]);
  const files = useMemo(() => (workflow?.files ?? []).filter(f => CSV_EXTS.has(extensionOf(f.name))), [workflow?.files]);
  const [picked,   setPicked]   = useState(null);
  const [parsed,   setParsed]   = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [tab,      setTab]      = useState("preview"); // "preview" | "stats"

  const handlePick = useCallback(async (f) => {
    setPicked(f.name); setParsed(null); setLoading(true);
    const x = await extractTextContent(f);
    if (x?.content) {
      const sep = extensionOf(f.name) === ".tsv" ? "\t" : ",";
      const text = sep === "\t" ? x.content.replace(/,/g, ";").replace(/\t/g, ",") : x.content;
      setParsed(parseCSVText(text));
    }
    setLoading(false);
  }, []);

  return (
    <ToolShell title="Table / CSV Analyzer" IconComponent={Table2} onClose={onClose}
      headerRight={parsed && (
        <>
          <button className={`tool-tab-btn${tab === "preview" ? " active" : ""}`} onClick={() => setTab("preview")}>Preview</button>
          <button className={`tool-tab-btn${tab === "stats" ? " active" : ""}`} onClick={() => setTab("stats")}>Stats</button>
        </>
      )}>
      {files.length === 0 ? (
        <p className="tool-empty">No CSV / TSV files found in this folder.</p>
      ) : (
        <div className="tool-two-col">
          <div className="tool-left">
            <div className="tool-section-head"><span>{files.length} spreadsheets</span></div>
            <div className="tool-file-list">
              {files.map(f => (
                <div key={f.path} className={`tool-file-item${picked === f.name ? " active" : ""}`} onClick={() => handlePick(f)}>
                  {f.name}
                </div>
              ))}
            </div>
          </div>
          <div className="tool-right">
            {!picked && <p className="tool-empty">Click a file to analyze it.</p>}
            {loading && <p className="tool-empty">Parsing…</p>}
            {parsed && tab === "preview" && (
              <>
                <div className="tool-stat-row"><span>{parsed.rows.length} rows</span><span>{parsed.headers.length} columns</span></div>
                <div className="tool-table-wrap">
                  <table className="tool-table">
                    <thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
                    <tbody>{parsed.rows.slice(0, 30).map((r, i) => (
                      <tr key={i}>{parsed.headers.map(h => <td key={h}>{r[h]}</td>)}</tr>
                    ))}</tbody>
                  </table>
                </div>
                {parsed.rows.length > 30 && <p className="tool-hint">Showing first 30 of {parsed.rows.length} rows.</p>}
              </>
            )}
            {parsed && tab === "stats" && (
              <div className="tool-table-wrap">
                <table className="tool-table">
                  <thead><tr><th>Column</th><th>Type</th><th>Count</th><th>Missing</th><th>Details</th></tr></thead>
                  <tbody>{csvStats(parsed.headers, parsed.rows).map(s => (
                    <tr key={s.col}>
                      <td><strong>{s.col}</strong></td>
                      <td><span className={`tool-type-badge tool-type-${s.type}`}>{s.type}</span></td>
                      <td>{s.count}</td>
                      <td>{s.missing > 0 ? <span className="tool-warn">{s.missing}</span> : "0"}</td>
                      <td className="tool-details">{s.type === "numeric" ? `min ${s.min} · max ${s.max} · mean ${s.mean}` : `${s.unique} unique · e.g. ${s.sample}`}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ─── Data Cleaner panel ───────────────────────────────────────────────────────

function DataCleanerPanel({ workflow, onClose }) {
  const CSV_EXTS = new Set([".csv", ".tsv"]);
  const files = useMemo(() => (workflow?.files ?? []).filter(f => CSV_EXTS.has(extensionOf(f.name))), [workflow?.files]);
  const [picked, setPicked] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleScan = useCallback(async (f) => {
    setPicked(f.name); setReport(null); setLoading(true);
    const x = await extractTextContent(f);
    if (!x?.content) { setLoading(false); return; }
    const { headers, rows } = parseCSVText(x.content);
    const totalRows = rows.length;
    const dups = totalRows - new Set(rows.map(r => JSON.stringify(r))).size;
    const cols = csvStats(headers, rows);
    const issues = cols.filter(c => c.missing > 0 || (c.type === "text" && c.unique === 1));
    setReport({ totalRows, headers: headers.length, dups, cols, issues });
    setLoading(false);
  }, []);

  return (
    <ToolShell title="Data Cleaner" IconComponent={Filter} onClose={onClose}>
      {files.length === 0 ? <p className="tool-empty">No CSV files found in this folder.</p> : (
        <div className="tool-two-col">
          <div className="tool-left">
            <div className="tool-section-head"><span>{files.length} CSV files</span></div>
            <div className="tool-file-list">
              {files.map(f => <div key={f.path} className={`tool-file-item${picked === f.name ? " active" : ""}`} onClick={() => handleScan(f)}>{f.name}</div>)}
            </div>
          </div>
          <div className="tool-right">
            {!picked && <p className="tool-empty">Click a file to run the data quality scan.</p>}
            {loading && <p className="tool-empty">Scanning…</p>}
            {report && (
              <>
                <div className="tool-stat-row">
                  <span>{report.totalRows} rows</span><span>{report.headers} cols</span>
                  <span className={report.dups > 0 ? "tool-warn" : ""}>{report.dups} duplicates</span>
                </div>
                <div className="tool-section-head" style={{marginTop:10}}>Column quality</div>
                <div className="tool-table-wrap">
                  <table className="tool-table">
                    <thead><tr><th>Column</th><th>Type</th><th>Missing</th><th>Issue</th></tr></thead>
                    <tbody>{report.cols.map(c => (
                      <tr key={c.col}>
                        <td>{c.col}</td>
                        <td><span className={`tool-type-badge tool-type-${c.type}`}>{c.type}</span></td>
                        <td>{c.missing > 0 ? <span className="tool-warn">{c.missing} ({Math.round(c.missing/report.totalRows*100)}%)</span> : <span className="tool-ok">✓</span>}</td>
                        <td className="tool-details">{c.missing > 0 ? "Has missing values" : c.type === "text" && c.unique === 1 ? "Only 1 unique value — constant column" : "OK"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="tool-section-head" style={{marginTop:10}}>Summary</div>
                <p className="tool-hint">
                  {report.issues.length === 0 ? "✓ No data quality issues detected." : `⚠ ${report.issues.length} column(s) have issues: ${report.issues.map(i => i.col).join(", ")}`}
                  {report.dups > 0 ? ` · ${report.dups} duplicate rows found.` : ""}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ─── Chart Builder panel ──────────────────────────────────────────────────────

function ChartBuilderPanel({ workflow, onClose }) {
  const CSV_EXTS = new Set([".csv", ".tsv"]);
  const files = useMemo(() => (workflow?.files ?? []).filter(f => CSV_EXTS.has(extensionOf(f.name))), [workflow?.files]);
  const [picked, setPicked]   = useState(null);
  const [parsed, setParsed]   = useState(null);
  const [xCol,   setXCol]     = useState("");
  const [yCol,   setYCol]     = useState("");
  const [type,   setType]     = useState("bar"); // "bar" | "line"
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef(null);

  const handlePick = useCallback(async (f) => {
    setPicked(f.name); setParsed(null); setXCol(""); setYCol(""); setLoading(true);
    const x = await extractTextContent(f);
    if (x?.content) {
      const p = parseCSVText(x.content, 500);
      setParsed(p);
      const stats = csvStats(p.headers, p.rows);
      const numCol = stats.find(s => s.type === "numeric");
      const txtCol = stats.find(s => s.type === "text");
      setXCol(txtCol?.col || p.headers[0] || "");
      setYCol(numCol?.col || p.headers[1] || "");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !parsed || !xCol || !yCol) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const data = parsed.rows.slice(0, 40);
    const labels = data.map(r => String(r[xCol] ?? "").slice(0, 15));
    const values = data.map(r => parseFloat(r[yCol]) || 0);
    const maxV = Math.max(...values, 1);
    const W = canvas.width, H = canvas.height;
    const padL = 50, padB = 60, padT = 20, padR = 10;
    const plotW = W - padL - padR, plotH = H - padB - padT;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fffdf9"; ctx.fillRect(0, 0, W, H);
    // Axes
    ctx.strokeStyle = "#d4ccc2"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
    // Y labels
    ctx.fillStyle = "#8a7f72"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const v = (maxV * i / 4).toFixed(1);
      const y = padT + plotH - (i / 4) * plotH;
      ctx.fillText(v, padL - 5, y + 3);
      ctx.strokeStyle = "#ede7de"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    }
    const barW = Math.min(plotW / labels.length - 2, 40);
    const colors = ["#e87a3e", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899"];
    if (type === "bar") {
      labels.forEach((lbl, i) => {
        const x = padL + (i / labels.length) * plotW + (plotW / labels.length - barW) / 2;
        const h = (values[i] / maxV) * plotH;
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x, padT + plotH - h, barW, h);
        // X label
        ctx.fillStyle = "#6b6157"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
        ctx.save(); ctx.translate(x + barW/2, padT + plotH + 5); ctx.rotate(-0.5);
        ctx.fillText(lbl, 0, 0); ctx.restore();
      });
    } else {
      ctx.strokeStyle = colors[0]; ctx.lineWidth = 2; ctx.beginPath();
      labels.forEach((_, i) => {
        const x = padL + (i + 0.5) / labels.length * plotW;
        const y = padT + plotH - (values[i] / maxV) * plotH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      labels.forEach((_, i) => {
        const x = padL + (i + 0.5) / labels.length * plotW;
        const y = padT + plotH - (values[i] / maxV) * plotH;
        ctx.fillStyle = colors[0]; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      });
      ctx.fillStyle = "#6b6157"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      labels.forEach((lbl, i) => {
        const x = padL + (i + 0.5) / labels.length * plotW;
        ctx.save(); ctx.translate(x, padT + plotH + 5); ctx.rotate(-0.5); ctx.fillText(lbl, 0, 0); ctx.restore();
      });
    }
    // Title
    ctx.fillStyle = "#3a3632"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${yCol} by ${xCol}`, W / 2, 14);
  }, [parsed, xCol, yCol, type]);

  return (
    <ToolShell title="Chart Builder" IconComponent={BarChart3} onClose={onClose}
      headerRight={parsed && (
        <>
          <button className={`tool-tab-btn${type === "bar" ? " active" : ""}`} onClick={() => setType("bar")}>Bar</button>
          <button className={`tool-tab-btn${type === "line" ? " active" : ""}`} onClick={() => setType("line")}>Line</button>
        </>
      )}>
      {files.length === 0 ? <p className="tool-empty">No CSV files found in this folder.</p> : (
        <div className="tool-two-col">
          <div className="tool-left">
            <div className="tool-section-head"><span>CSV files</span></div>
            <div className="tool-file-list">
              {files.map(f => <div key={f.path} className={`tool-file-item${picked === f.name ? " active" : ""}`} onClick={() => handlePick(f)}>{f.name}</div>)}
            </div>
            {parsed && (
              <div className="tool-col-pickers">
                <label className="tool-pick-label">X axis (label)</label>
                <select className="tool-select" value={xCol} onChange={e => setXCol(e.target.value)}>
                  {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <label className="tool-pick-label">Y axis (value)</label>
                <select className="tool-select" value={yCol} onChange={e => setYCol(e.target.value)}>
                  {parsed.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="tool-right">
            {!picked && <p className="tool-empty">Click a CSV file to plot it.</p>}
            {loading && <p className="tool-empty">Loading…</p>}
            {parsed && <canvas ref={canvasRef} width={520} height={320} className="tool-chart-canvas" />}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ─── Classifier / Tagger panel ────────────────────────────────────────────────

const STOP_WORDS = new Set(["the","and","for","are","was","with","this","that","have","from","they","will","been","said","each","which","their","there","what","about","when","into","more","also","than","then","some","these","those","would","could","should","very","just","like","well","over","only","such","most","both","after","before","other","your","our","all","but","not","you","his","her","she","her","him","who","how","its","yet","nor","nor","can","may","might","shall","upon","even","ever"]);

function ClassifierPanel({ workflow, onClose }) {
  const files = workflow?.files ?? [];
  const EXT_TAGS = {
    ".py": ["Python", "Code"], ".ipynb": ["Notebook", "Python"], ".r": ["R", "Statistics"],
    ".csv": ["Data", "Spreadsheet"], ".tsv": ["Data"], ".json": ["Data", "JSON"],
    ".pdf": ["Document", "PDF"], ".docx": ["Document", "Word"], ".doc": ["Document"],
    ".md": ["Documentation", "Markdown"], ".txt": ["Text"], ".png": ["Image"],
    ".jpg": ["Image"], ".jpeg": ["Image"], ".svg": ["Image", "Vector"],
    ".html": ["Web", "Code"], ".js": ["JavaScript", "Code"], ".ts": ["TypeScript", "Code"],
    ".sql": ["Database", "SQL"], ".sh": ["Script", "Shell"],
  };
  const SIZE_TAG = (s) => s > 10e6 ? "Large file" : s > 1e6 ? "Medium file" : "Small file";
  const NAME_TAGS = (n) => {
    const tags = [];
    if (/test/i.test(n)) tags.push("Test");
    if (/draft|temp|tmp/i.test(n)) tags.push("Draft");
    if (/final|v\d|version/i.test(n)) tags.push("Final version");
    if (/model|train|predict/i.test(n)) tags.push("ML/Model");
    if (/plot|chart|fig|graph/i.test(n)) tags.push("Visualization");
    if (/clean|process|prep/i.test(n)) tags.push("Data processing");
    return tags;
  };
  const tagged = useMemo(() => files.slice(0, 200).map(f => ({
    ...f,
    tags: [...new Set([...(EXT_TAGS[extensionOf(f.name)] || ["Other"]), SIZE_TAG(f.size || 0), ...NAME_TAGS(f.name)])],
  })), [files]);
  const [filter, setFilter] = useState("");
  const shown = filter ? tagged.filter(f => f.tags.some(t => t.toLowerCase().includes(filter.toLowerCase()))) : tagged;
  const allTags = [...new Set(tagged.flatMap(f => f.tags))].sort();

  return (
    <ToolShell title="Classifier / Tagger" IconComponent={BrainCircuit} onClose={onClose}
      headerRight={<span className="tool-count-badge">{tagged.length} files tagged</span>}>
      <div className="tool-section-head" style={{marginBottom:6}}>Filter by tag:</div>
      <div className="tool-tag-filter">
        <button className={`tool-tag-pill${!filter ? " active" : ""}`} onClick={() => setFilter("")}>All</button>
        {allTags.map(t => <button key={t} className={`tool-tag-pill${filter === t ? " active" : ""}`} onClick={() => setFilter(t === filter ? "" : t)}>{t}</button>)}
      </div>
      <div className="tool-table-wrap" style={{marginTop:8}}>
        <table className="tool-table">
          <thead><tr><th>File</th><th>Tags</th><th>Size</th></tr></thead>
          <tbody>{shown.slice(0, 100).map(f => (
            <tr key={f.path}>
              <td title={f.path}>{f.name}</td>
              <td><div className="tool-tag-row">{f.tags.map(t => <span key={t} className="tool-tag">{t}</span>)}</div></td>
              <td>{formatBytes(f.size)}</td>
            </tr>
          ))}</tbody>
        </table>
        {shown.length > 100 && <p className="tool-hint">Showing 100 of {shown.length} matches.</p>}
      </div>
    </ToolShell>
  );
}

// ─── Insight Summarizer panel ─────────────────────────────────────────────────

function InsightSummarizerPanel({ workflow, onClose }) {
  const DOC_EXTS = new Set([".pdf", ".docx", ".doc", ".txt", ".md", ".py", ".ipynb"]);
  const files = useMemo(() => (workflow?.files ?? []).filter(f => DOC_EXTS.has(extensionOf(f.name))), [workflow?.files]);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleAnalyze = useCallback(async () => {
    setLoading(true); setResults(null);
    const MAX = 30;
    let allText = "", docLengths = [], filesDone = 0;
    for (const f of files.slice(0, MAX)) {
      const x = await extractTextContent(f);
      if (x?.content) { allText += " " + x.content; docLengths.push(x.content.split(/\s+/).length); }
      filesDone++;
    }
    const words = allText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const freq = {};
    for (const w of words) { if (!STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1; }
    const topWords = Object.entries(freq).sort(([,a],[,b]) => b-a).slice(0, 30);
    const avgLen = docLengths.length ? Math.round(docLengths.reduce((a,b) => a+b,0) / docLengths.length) : 0;
    setResults({ topWords, docCount: filesDone, avgLen, totalWords: words.length, docLengths });
    setLoading(false);
  }, [files]);

  return (
    <ToolShell title="Insight Summarizer" IconComponent={MessageSquareText} onClose={onClose}
      headerRight={!loading && <button className="tool-hbtn" onClick={handleAnalyze}>{results ? "Re-analyse" : "Analyse"}</button>}>
      {files.length === 0 && <p className="tool-empty">No text documents found in this folder.</p>}
      {files.length > 0 && !results && !loading && (
        <p className="tool-empty">Click <strong>Analyse</strong> to extract insights from up to 30 documents in this folder.</p>
      )}
      {loading && <p className="tool-empty">Extracting text from documents…</p>}
      {results && (
        <div className="tool-insights">
          <div className="tool-stat-cards">
            <div className="tool-stat-card"><div className="tool-stat-num">{results.docCount}</div><div>docs analysed</div></div>
            <div className="tool-stat-card"><div className="tool-stat-num">{results.totalWords.toLocaleString()}</div><div>total words</div></div>
            <div className="tool-stat-card"><div className="tool-stat-num">{results.avgLen.toLocaleString()}</div><div>avg words/doc</div></div>
          </div>
          <div className="tool-section-head" style={{margin:"12px 0 6px"}}>Top keywords</div>
          <div className="tool-keyword-cloud">
            {results.topWords.map(([w, c]) => (
              <span key={w} className="tool-keyword" style={{ fontSize: Math.max(11, Math.min(22, 11 + c / results.topWords[0][1] * 11)) }}>
                {w} <sup>{c}</sup>
              </span>
            ))}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ─── Report Writer panel ──────────────────────────────────────────────────────

function ReportWriterPanel({ workflow, onClose }) {
  const [report, setReport] = useState(null);

  const generate = useCallback(() => {
    const s = summarizeFiles(workflow?.files ?? []);
    const now = new Date().toLocaleString();
    const catSections = Object.entries(s.categories).filter(([,c]) => c > 0).map(([cat, count]) => {
      const catFiles = (workflow?.files ?? []).filter(f => f.category === cat);
      const exts = {};
      catFiles.forEach(f => { const e = extensionOf(f.name); exts[e] = (exts[e]||0)+1; });
      const extList = Object.entries(exts).sort(([,a],[,b])=>b-a).map(([e,c])=>`\`${e}\` (${c})`).join(", ");
      return `### ${cat} — ${count} file${count!==1?"s":""}\nExtensions: ${extList || "mixed"}`;
    }).join("\n\n");

    const fileList = (workflow?.files ?? []).slice(0, 100).map(f =>
      `- \`${f.path}\` — ${formatBytes(f.size)}`
    ).join("\n");

    const md = `# Folder Analysis Report: ${workflow?.folderName || "Unknown"}

_Generated: ${now}_

---

## Overview

| Metric | Value |
|---|---|
| Folder | ${workflow?.folderName || "—"} |
| Total files | ${s.fileCount} |
| Total size | ${s.totalSize} |
| Newest file | ${s.newestModified ? new Date(s.newestModified).toLocaleDateString() : "Unknown"} |

## Categories

${catSections}

## Top Extensions

${s.topExtensions.map(e => `- \`${e.extension}\`: ${e.count} file${e.count!==1?"s":""}`).join("\n")}

## File Listing (first 100)

${fileList}${s.fileCount > 100 ? `\n\n_...and ${s.fileCount - 100} more files._` : ""}
`;
    setReport(md);
  }, [workflow]);

  const download = () => {
    const blob = new Blob([report], { type: "text/markdown" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `${workflow?.folderName || "folder"}-report.md`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <ToolShell title="Report Writer" IconComponent={ClipboardList} onClose={onClose}
      headerRight={<>
        <button className="tool-hbtn" onClick={generate}>{report ? "Regenerate" : "Generate"}</button>
        {report && <button className="tool-hbtn" onClick={download}>Download .md</button>}
      </>}>
      {!report && <p className="tool-empty">Click <strong>Generate</strong> to create a full markdown report of this folder.</p>}
      {report && <pre className="tool-report-pre">{report}</pre>}
    </ToolShell>
  );
}

// ─── Web Research Agent panel ─────────────────────────────────────────────────

function WebResearchPanel({ workflow, onClose }) {
  const [query, setQuery] = useState(() => workflow?.folderName || "");
  const searches = [
    { label: "Google Scholar", url: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}` },
    { label: "arXiv",          url: (q) => `https://arxiv.org/search/?query=${encodeURIComponent(q)}&searchtype=all` },
    { label: "Google",         url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { label: "Semantic Scholar",url:(q) => `https://www.semanticscholar.org/search?q=${encodeURIComponent(q)}&sort=Relevance` },
    { label: "PubMed",         url: (q) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(q)}` },
  ];

  return (
    <ToolShell title="Web Research Agent" IconComponent={Globe2} onClose={onClose}>
      <div className="tool-section-head">Search query</div>
      <div className="tool-search-row">
        <input className="tool-query-input" value={query} onChange={e => setQuery(e.target.value)}
               placeholder="Enter a research topic or keyword…" onKeyDown={e => e.key === "Enter" && searches[0].url && window.open(searches[0].url(query))} />
      </div>
      <div className="tool-section-head" style={{marginTop:12}}>Open search in new tab</div>
      <div className="tool-search-btns">
        {searches.map(s => (
          <button key={s.label} className="tool-search-btn" disabled={!query.trim()}
                  onClick={() => window.open(s.url(query.trim()), "_blank")}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="tool-hint" style={{marginTop:12}}>Pre-filled with the folder name. Edit the query to refine your search.</p>
    </ToolShell>
  );
}

// ─── HTTP / API Request panel ─────────────────────────────────────────────────

function APIRequestPanel({ workflow, onClose }) {
  const [method, setMethod]   = useState("GET");
  const [url,    setUrl]      = useState("");
  const [body,   setBody]     = useState("");
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSend = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/http-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, url, body: body || undefined }),
      });
      const data = await res.json();
      setResult(data);
    } catch {
      // Backend not running — try direct fetch (CORS may block)
      try {
        const res = await fetch(url, { method, body: method !== "GET" ? body : undefined, headers: { "Content-Type": "application/json" } });
        const text = await res.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        setResult({ status: res.status, statusText: res.statusText, data: parsed });
      } catch (e2) {
        setResult({ error: e2.message + "\n\nFor cross-origin requests, start the backend: cd workflow-engine && node server.js" });
      }
    } finally {
      setLoading(false);
    }
  }, [method, url, body]);

  return (
    <ToolShell title="HTTP / API Request" IconComponent={Link} onClose={onClose}>
      <div className="tool-request-row">
        <select className="tool-method-select" value={method} onChange={e => setMethod(e.target.value)}>
          {["GET","POST","PUT","DELETE","PATCH"].map(m => <option key={m}>{m}</option>)}
        </select>
        <input className="tool-url-input" value={url} onChange={e => setUrl(e.target.value)}
               placeholder="https://api.example.com/data" />
        <button className="tool-run-btn" disabled={!url.trim() || loading} onClick={handleSend}>
          {loading ? "Sending…" : "Send"}
        </button>
      </div>
      {method !== "GET" && (
        <>
          <div className="tool-section-head" style={{marginTop:8}}>Request body (JSON)</div>
          <textarea className="tool-body-editor" value={body} onChange={e => setBody(e.target.value)}
                    placeholder='{"key": "value"}' rows={4} />
        </>
      )}
      {result && (
        <>
          <div className="tool-section-head" style={{marginTop:10}}>
            Response {result.status && <span className={`tool-status-badge ${result.status < 300 ? "ok" : "err"}`}>{result.status} {result.statusText}</span>}
          </div>
          {result.error
            ? <pre className="tool-response tool-response--err">{result.error}</pre>
            : <pre className="tool-response">{typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)}</pre>
          }
        </>
      )}
    </ToolShell>
  );
}

// ─── Tool panel dispatcher ────────────────────────────────────────────────────

function ToolPanel({ toolId, workflow, onClose }) {
  if (toolId === "document-extractor") return <DocumentExtractorPanel workflow={workflow} onClose={onClose} />;
  if (toolId === "table-analyzer")     return <CSVAnalyzerPanel       workflow={workflow} onClose={onClose} />;
  if (toolId === "data-cleaner")       return <DataCleanerPanel       workflow={workflow} onClose={onClose} />;
  if (toolId === "chart-builder")      return <ChartBuilderPanel      workflow={workflow} onClose={onClose} />;
  if (toolId === "classifier")         return <ClassifierPanel        workflow={workflow} onClose={onClose} />;
  if (toolId === "insight-summarizer") return <InsightSummarizerPanel workflow={workflow} onClose={onClose} />;
  if (toolId === "report-writer")      return <ReportWriterPanel      workflow={workflow} onClose={onClose} />;
  if (toolId === "web-research")       return <WebResearchPanel       workflow={workflow} onClose={onClose} />;
  if (toolId === "api-request")        return <APIRequestPanel        workflow={workflow} onClose={onClose} />;
  return null;
}

// ─── IDE opener panel ─────────────────────────────────────────────────────────

const IDES = [
  { id: "vscode",     label: "VS Code",    icon: "⌨️" },
  { id: "cursor",     label: "Cursor",     icon: "🖱️" },
  { id: "zed",        label: "Zed",        icon: "⚡" },
  { id: "jupyterlab", label: "JupyterLab", icon: "📓" },
  { id: "pycharm",    label: "PyCharm",    icon: "🐍" },
];

const PATH_CACHE_KEY = (name) => `ide-resolved-path:${name}`;

// If a file path accidentally ended up in the workspace field, walk up to its parent directory.
function toFolderPath(p) {
  if (!p) return p;
  const last = p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  // Has a recognised file extension → it's a file, not a folder
  if (/\.\w{1,10}$/.test(last)) return p.slice(0, p.lastIndexOf("/")) || p;
  return p;
}

function IDEOpenerPanel({ workflow, onClose }) {
  const folderName = workflow?.folderName ?? "";

  // Seed from localStorage — sanitize in case a file path was accidentally cached
  const [workspacePath, setWorkspacePath] = useState(() => {
    try { return toFolderPath(localStorage.getItem(PATH_CACHE_KEY(folderName))) || folderName; } catch { return folderName; }
  });
  const [alternatives, setAlternatives] = useState([]); // other matches found
  const [resolving,    setResolving]    = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [status,       setStatus]       = useState(null);

  const pyFiles = useMemo(
    () => (workflow?.files ?? []).filter(f => { const e = extensionOf(f.name); return e === ".py" || e === ".ipynb"; }),
    [workflow?.files]
  );

  // Try to auto-resolve via backend (mdfind on macOS — instant full-disk search)
  useEffect(() => {
    if (!folderName) return;
    const cached = (() => { try { return localStorage.getItem(PATH_CACHE_KEY(folderName)); } catch { return null; } })();
    if (cached) return; // already have a confirmed absolute path

    setResolving(true);
    fetch(`${BACKEND_URL}/api/resolve-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderName }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.found && data.path) {
          const clean = toFolderPath(data.path);
          setWorkspacePath(clean);
          try { localStorage.setItem(PATH_CACHE_KEY(folderName), clean); } catch {}
          const alts = (data.alternatives || []).map(toFolderPath).filter(Boolean);
          if (alts.length > 1) setAlternatives(alts);
        } else if (data.suggestions?.length) {
          setAlternatives(data.suggestions.slice(0, 3).map(s => `${s}  ← not found`));
        }
      })
      .catch(() => {}) // backend not running — user will see the warn hint
      .finally(() => setResolving(false));
  }, [folderName]);

  // Strip the folder-name prefix that webkitdirectory scanning includes in paths
  const resolvedFilePath = useCallback((ws) => {
    if (!selectedFile || !ws) return null;
    const folderName = workflow?.folderName ?? "";
    // webkitdirectory gives "FolderName/sub/file.py" — strip the root prefix
    const rel = selectedFile.startsWith(folderName + "/")
      ? selectedFile.slice(folderName.length + 1)
      : selectedFile;
    return `${ws}/${rel}`;
  }, [selectedFile, workflow?.folderName]);

  const handleOpen = useCallback(async (ide) => {
    const ws = workspacePath.trim();
    if (!ws) { setStatus({ type: "error", text: "Enter the full path to your project folder." }); return; }

    const fp = resolvedFilePath(ws);
    const isAbsPath = ws.startsWith("/") || /^[A-Za-z]:\\/.test(ws);

    // ── Browser-native: no backend required ───────────────────────────────
    if (ide.id === "vscode" || ide.id === "cursor") {
      const scheme = ide.id === "vscode" ? "vscode" : "cursor";
      if (isAbsPath) {
        const uri = fp ? `${scheme}://file${fp}` : `${scheme}://file${ws}/`;
        window.open(uri, "_blank");
        // Persist confirmed absolute path so it's pre-filled next time
        try { localStorage.setItem(PATH_CACHE_KEY(folderName), ws); } catch {}
        setStatus({ type: "success", text: `${ide.label} launch requested via ${scheme}:// — it should open shortly.` });
        return;
      }
      // If path isn't absolute yet, fall through to backend
    }

    if (ide.id === "jupyterlab") {
      // Try opening the local JupyterLab server (no backend needed)
      const rel = fp ? fp.replace(ws, "").replace(/^\//, "") : "";
      const jlUrl = `http://localhost:8888/lab/tree/${encodeURIComponent(rel || "")}`;
      window.open(jlUrl, "_blank");
      setStatus({ type: "success", text: `JupyterLab tab opened — make sure JupyterLab is running on port 8888.` });
      return;
    }

    // ── Backend path (PyCharm, Zed, or fallback when path not absolute) ───
    setStatus({ type: "info", text: `Opening ${ide.label}…` });
    try {
      const res = await fetch(`${BACKEND_URL}/api/open-in-ide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspacePath: ws, filePath: fp, ide: ide.id }),
      });
      const data = await res.json();
      if (data.success) {
        try { localStorage.setItem(PATH_CACHE_KEY(folderName), ws); } catch {}
        setStatus({ type: "success", text: `${ide.label} opened${fp ? ` · ${fp.split("/").pop()}` : ""}.` });
      } else {
        const msg = data.error || "Failed to open IDE.";
        setStatus({
          type: "error",
          text: msg.includes("not found") || msg.includes("command not found")
            ? `${ide.label} CLI not found. Install it or add it to your PATH.`
            : msg,
        });
      }
    } catch {
      setStatus({
        type: "error",
        text: ide.id === "vscode" || ide.id === "cursor"
          ? `Enter the full absolute path (e.g. /Users/you/Desktop/Paper3) to open without the backend.`
          : `Backend not reachable. Start it: cd workflow-engine && node server.js`,
      });
    }
  }, [workspacePath, resolvedFilePath]);

  return (
    <div className="ide-panel">
      <div className="ide-panel-header">
        <span className="ide-panel-title"><Braces size={16}/> Open in IDE</span>
        {workflow?.folderName && (
          <span className="ide-panel-folder">"{workflow.folderName}"</span>
        )}
        <button className="ide-close-btn" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="ide-panel-body">

        {/* ── Workspace path ── */}
        <div className="ide-section">
          <div className="ide-label-row">
            <label className="ide-label">Project folder path</label>
            <button className="ide-reset-btn" title="Clear cached path and re-detect"
                    onClick={() => {
                      try { localStorage.removeItem(PATH_CACHE_KEY(folderName)); } catch {}
                      setWorkspacePath(folderName);
                      setAlternatives([]);
                      setStatus(null);
                    }}>
              Reset
            </button>
          </div>
          <input
            className={`ide-path-input${resolving ? " ide-path-input--loading" : ""}`}
            type="text"
            value={workspacePath}
            onChange={e => { setWorkspacePath(e.target.value); setAlternatives([]); }}
            onBlur={e => {
              const clean = toFolderPath(e.target.value.trim());
              if (clean !== e.target.value) setWorkspacePath(clean);
            }}
            placeholder={resolving ? `Searching for "${folderName}" via Spotlight…` : "Paste your folder path here"}
            disabled={resolving}
          />
          {resolving && (
            <p className="ide-hint">🔍 Spotlight is searching for <strong>{folderName}</strong> across your entire Mac…</p>
          )}
          {!resolving && (!workspacePath || (!workspacePath.startsWith("/") && !workspacePath.startsWith("~"))) && (
            <div className="ide-path-help">
              <p className="ide-hint">Path not resolved yet. Two ways to get the real path:</p>
              <ol className="ide-hint-steps">
                <li>
                  <strong>Auto (recommended):</strong> start the backend once →&nbsp;
                  <code>cd workflow-engine &amp;&amp; node server.js</code>
                  , then click&nbsp;<button className="ide-inline-btn" onClick={() => {
                    setResolving(true);
                    fetch(`${BACKEND_URL}/api/resolve-path`, {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ folderName }),
                    }).then(r => r.json())
                      .then(d => { if (d.found) { const c = toFolderPath(d.path); setWorkspacePath(c); try { localStorage.setItem(PATH_CACHE_KEY(folderName), c); } catch {} } })
                      .catch(() => {})
                      .finally(() => setResolving(false));
                  }}>Detect now ↺</button>
                </li>
                <li>
                  <strong>Manual:</strong> in Finder, right-click the <em>{folderName}</em> folder → hold <kbd>Option</kbd> → click <strong>Copy "{folderName}" as Pathname</strong> → paste above.
                </li>
              </ol>
            </div>
          )}
          {alternatives.length > 1 && (
            <div className="ide-alternatives">
              <span className="ide-alt-label">Multiple matches — pick one:</span>
              {alternatives.map(p => (
                <button key={p} className={`ide-alt-item${workspacePath === p ? " ide-alt-item--active" : ""}`}
                        onClick={() => {
                          const clean = toFolderPath(p.replace("  ← not found", "").trim());
                          setWorkspacePath(clean);
                          try { localStorage.setItem(PATH_CACHE_KEY(folderName), clean); } catch {};
                        }}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── File selector ── */}
        {pyFiles.length > 0 && (
          <div className="ide-section">
            <label className="ide-label">Open a specific file (optional)</label>
            <div className="ide-file-list">
              {/* "Just open the folder" row shows the workspace absolute path */}
              <div className={`ide-file-item${!selectedFile ? " ide-file-item--active" : ""}`}
                   onClick={() => setSelectedFile(null)}
                   title={workspacePath || folderName}>
                <FolderOpen size={13}/>
                <span className="ide-file-abs">{workspacePath || folderName}</span>
              </div>
              {pyFiles.map(f => {
                // Strip leading "FolderName/" prefix that webkitdirectory adds
                const rel = f.path.startsWith(folderName + "/")
                  ? f.path.slice(folderName.length + 1)
                  : f.path;
                const isAbsWs = workspacePath.startsWith("/") || /^[A-Za-z]:\\/.test(workspacePath);
                const absPath = isAbsWs ? `${workspacePath}/${rel}` : rel;
                return (
                  <div key={f.path}
                       className={`ide-file-item${selectedFile === f.path ? " ide-file-item--active" : ""}`}
                       onClick={() => setSelectedFile(f.path)}
                       title={absPath}>
                    <Braces size={13}/>
                    <span className="ide-file-abs">{absPath}</span>
                  </div>
                );
              })}
            </div>
            {/* Show full path of currently selected file under the list */}
            {selectedFile && (() => {
              const rel = selectedFile.startsWith(folderName + "/")
                ? selectedFile.slice(folderName.length + 1)
                : selectedFile;
              const isAbsWs = workspacePath.startsWith("/") || /^[A-Za-z]:\\/.test(workspacePath);
              const abs = isAbsWs ? `${workspacePath}/${rel}` : rel;
              return (
                <div className="ide-selected-path">
                  <span className="ide-selected-label">Will open:</span>
                  <code className="ide-selected-code">{abs}</code>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── IDE buttons ── */}
        <div className="ide-section">
          <label className="ide-label">Open in</label>
          <div className="ide-btn-grid">
            {IDES.map(ide => (
              <button key={ide.id} className="ide-open-btn" onClick={() => handleOpen(ide)}>
                <span className="ide-btn-icon">{ide.icon}</span>
                {ide.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Status ── */}
        {status && (
          <div className={`ide-status ide-status--${status.type}`}>
            {status.type === "success" && <CheckCircle2 size={14}/>}
            {status.type === "error"   && <XCircle size={14}/>}
            {status.type === "info"    && <Info size={14}/>}
            {status.text}
          </div>
        )}

        <p className="ide-footer-note">
          <strong>VS Code &amp; Cursor</strong> — once the path field shows a real absolute path (starts with <code>/</code>) they open via browser URI, no backend needed.<br/>
          <strong>JupyterLab</strong> — opens <code>localhost:8888</code> in a new tab; requires JupyterLab already running.<br/>
          <strong>PyCharm &amp; Zed</strong> — always need the backend running.
        </p>
      </div>
    </div>
  );
}

// ─── Python panel ─────────────────────────────────────────────────────────────

const PYTHON_STARTER = `# Python Analysis Step
# Injected variables:
#   files           - list of {name, path, size, category, content?}
#                     'content' holds extracted text when "Load file contents" is enabled
#   previous_output - output from the previous workflow node

from collections import Counter

files_with_content = [f for f in files if f.get("content")]
files_meta_only    = [f for f in files if not f.get("content")]

print(f"Total files : {len(files)}")
print(f"With content: {len(files_with_content)}")

if files_with_content:
    print("\\n── Content preview ─────────────────────")
    for f in files_with_content[:5]:
        preview = f["content"][:400].replace("\\n", " ")
        trunc   = " …" if len(f["content"]) > 400 else ""
        print(f"\\n[{f['name']}]\\n{preview}{trunc}")
else:
    cats     = Counter(f["category"] for f in files)
    total_mb = sum(f.get("size", 0) for f in files) / (1024 * 1024)
    print(f"Total size  : {total_mb:.2f} MB")
    print("\\nBy category:")
    for cat, n in cats.most_common():
        print(f"  {cat:<14} {n:>5} files")
    print("\\nTip: enable 'Load file contents' to read actual text from PDFs, docs, and code files.")
`.trimStart();

const BACKEND_URL = "http://localhost:3001";

function PythonPanel({ workflow, nodeId, initialCode, onCodeChange, onRunComplete, onClose }) {
  const [code,         setCode]         = useState(initialCode ?? PYTHON_STARTER);
  const [output,       setOutput]       = useState(null); // { stdout, stderr, figures, success }
  const [runStatus,    setRunStatus]    = useState(null); // string while busy, null when idle
  const [pyReady,      setPyReady]      = useState(false);
  const [loadContents, setLoadContents] = useState(false);
  const [contentStats, setContentStats] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null); // name of file loaded into editor

  // Kick off Pyodide load as soon as the panel mounts
  useEffect(() => {
    setRunStatus("Loading Python runtime (one-time download)…");
    loadPyodideRuntime()
      .then(() => { setPyReady(true); setRunStatus(null); })
      .catch(e => setRunStatus(`Failed to load Python: ${e.message}`));
  }, []);

  // .py and .ipynb files in the active workflow
  const pyFiles = useMemo(
    () => (workflow?.files ?? []).filter(f => { const e = extensionOf(f.name); return e === ".py" || e === ".ipynb"; }),
    [workflow?.files]
  );

  const handleFileSelect = useCallback(async (fname) => {
    const entry = pyFiles.find(f => f.name === fname);
    if (!entry) return;
    setSelectedFile(fname);
    const extracted = await extractTextContent(entry);
    if (!extracted?.content) return;
    const ext = extensionOf(fname);
    let newCode = extracted.content;
    if (ext === ".ipynb") {
      try {
        const nb = JSON.parse(extracted.content);
        const rawCells = nb.cells ?? nb.worksheets?.[0]?.cells ?? [];
        const codeCells = rawCells.filter(c => String(c.cell_type ?? "").trim().toLowerCase() === "code");
        newCode = codeCells.map((c, i) => {
          const src = Array.isArray(c.source) ? c.source.join("") : String(c.source ?? "");
          return `# ─── Cell ${i + 1} ────────────────────────────────────\n${src}`;
        }).join("\n\n") || "# No code cells found in this notebook";
      } catch { /* keep raw content */ }
    }
    setCode(newCode);
    onCodeChange?.(nodeId, newCode);
  }, [pyFiles, nodeId, onCodeChange]);

  const handleCodeChange = useCallback((e) => {
    setCode(e.target.value);
    setSelectedFile(null);
    onCodeChange?.(nodeId, e.target.value);
  }, [nodeId, onCodeChange]);

  const handleRun = useCallback(async () => {
    if (!pyReady) return;
    const startMs = Date.now();
    setOutput(null);

    let enrichedFiles = (workflow?.files ?? []).map(
      ({ name, path, size, category }) => ({ name, path, size, category })
    );

    if (loadContents && workflow?.files?.length) {
      setRunStatus("Extracting file contents…");
      let totalBytes = 0, loadedCount = 0;
      enrichedFiles = await Promise.all(
        workflow.files.slice(0, 20).map(async f => {
          const base = { name: f.name, path: f.path, size: f.size, category: f.category };
          const x = await extractTextContent(f);
          if (x?.content) { totalBytes += x.content.length; loadedCount++; return { ...base, content: x.content, contentTruncated: !!x.truncated }; }
          return base;
        })
      );
      setContentStats({ count: loadedCount, totalKB: Math.round(totalBytes / 1024) });
    }

    try {
      const result = await runPythonBrowser(code, enrichedFiles, setRunStatus, selectedFile ?? "script.py");
      setOutput(result);
      onRunComplete?.({
        timestamp: new Date().toISOString(),
        duration:  Date.now() - startMs,
        success:   result.success,
        exitCode:  result.success ? 0 : 1,
        stdout:    result.stdout,
        stderr:    result.stderr,
        figures:   result.figures,
      });
    } catch (e) {
      setOutput({ success: false, stdout: "", stderr: e.message, figures: [] });
    } finally {
      setRunStatus(null);
    }
  }, [pyReady, code, workflow, loadContents, onRunComplete]);

  const busy = !!runStatus;

  return (
    <div className="py-panel">
      <div className="py-panel-header">
        <div className="py-panel-title">
          <Braces size={16} />
          <strong>Python Analysis Step</strong>
          {workflow?.folderName && (
            <span className="py-panel-ctx">{workflow.files.length} files · "{workflow.folderName}"</span>
          )}
        </div>
        <div className="py-panel-actions">
          {pyFiles.length > 0 && (
            <select className="py-file-select" value={selectedFile ?? ""}
                    onChange={e => e.target.value && handleFileSelect(e.target.value)}>
              <option value="">Open file from folder…</option>
              {pyFiles.map(f => <option key={f.path} value={f.name}>{f.name}</option>)}
            </select>
          )}
          <label className="py-content-toggle" title="Extract text from PDFs, DOCX, and code files before running">
            <input type="checkbox" checked={loadContents}
                   onChange={e => { setLoadContents(e.target.checked); setContentStats(null); }} />
            Load file contents
          </label>
          {contentStats && (
            <span className="py-content-stats">{contentStats.count} files · {contentStats.totalKB} KB</span>
          )}
          <button className={`py-run-btn${busy ? " py-run-btn--busy" : ""}`}
                  onClick={handleRun} disabled={busy || !pyReady} title={!pyReady ? "Waiting for Python runtime…" : ""}>
            {busy ? (runStatus?.length > 28 ? runStatus.slice(0, 26) + "…" : runStatus) : "▶  Run Python"}
          </button>
          <button className="py-close-btn" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      <div className="py-panel-body">
        <div className="py-editor-col">
          <div className="py-editor-hint">
            {!pyReady
              ? <span className="py-loading-hint">⏳ {runStatus ?? "Loading Python…"}</span>
              : <>
                  {selectedFile && <span className="py-file-badge">📄 {selectedFile} &nbsp;</span>}
                  <code>files[i].content</code> — text content (with toggle on) &nbsp;·&nbsp;
                  <code>plt.show()</code> — captures plots
                </>
            }
          </div>
          <textarea className="py-textarea" value={code} onChange={handleCodeChange}
                    spellCheck={false} autoCorrect="off" autoCapitalize="off" />
        </div>

        <div className="py-output-col">
          <div className="py-output-label">Output</div>
          {!output && !busy && (
            <div className="py-output-empty">
              {pyReady
                ? <>Click <strong>▶ Run Python</strong> to execute.<br/><small>numpy · pandas · matplotlib supported. Plots captured automatically.</small></>
                : runStatus}
            </div>
          )}
          {busy && <div className="py-output-empty py-output-spinning">{runStatus}</div>}
          {output && !busy && (
            <>
              {output.stdout && <OutputViewer text={output.stdout} />}
              {output.figures?.length > 0 && (
                <div className="py-figures">
                  {output.figures.map((fig, i) => (
                    <img key={i} src={`data:image/png;base64,${fig}`} className="py-figure" alt={`Figure ${i + 1}`} />
                  ))}
                </div>
              )}
              {output.stderr && <OutputViewer text={output.stderr} isError />}
              {!output.stdout && !output.stderr && !output.figures?.length && (
                <div className="py-output-empty">Script completed with no output.</div>
              )}
              <div className={`py-exit${output.success ? "" : " py-exit--err"}`}>
                {output.success ? "✓ OK" : "✗ Error"}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── resizable sides wrapper ─────────────────────────────────────────────────
// Adds left + right drag handles to any section; combined with h-dividers above
// and below, this gives all-four-border resize for any workspace panel.

function ResizableSides({ children, className = "" }) {
  const [ml, setML] = useState(0);
  const [mr, setMR] = useState(0);
  const wrapRef = useRef(null);

  const makeSideDown = useCallback((side) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX  = e.clientX;
    const startML = ml, startMR = mr;
    const totalW  = wrapRef.current?.offsetWidth ?? 800;
    document.body.style.cursor     = "ew-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (side === "left")  setML(Math.max(0, Math.min(totalW - 300, startML + dx)));
      if (side === "right") setMR(Math.max(0, Math.min(totalW - 300, startMR - dx)));
    };
    const onUp = () => {
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, [ml, mr]);

  return (
    <div ref={wrapRef} className={`resizable-wrap ${className}`}
         style={{ marginLeft: ml, marginRight: mr }}>
      <div className="border-handle border-handle--left"
           onMouseDown={makeSideDown("left")} title="Drag to resize" />
      {children}
      <div className="border-handle border-handle--right"
           onMouseDown={makeSideDown("right")} title="Drag to resize" />
    </div>
  );
}

// ─── canvas wrapper ───────────────────────────────────────────────────────────

// Amount (px) to push nodes down when a file-list dropdown opens.
// Must be ≥ max-height of .node-file-list header + scroll area (~28+200+padding = 240px).
const FILE_LIST_SHIFT = 260;

function AppCanvas({ derivedNodes, derivedEdges, workflowCount, canvasH, canvasRef,
                     onNodeClick, onNodeDoubleClick, onConnect, onNodeDragStop, onDropTool, onNodesChange }) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const prevCount    = useRef(workflowCount);
  const expandedId   = useRef(null); // id of the node whose file-list is currently open
  const [nodes, setNodes, handleNodesChange] = useNodesState(derivedNodes);
  const [edges, setEdges, handleEdgesChange] = useEdgesState(derivedEdges);

  // Sync parent-derived nodes → local state, but only when no file-list is open
  // (so we don't collapse the expansion mid-hover)
  useEffect(() => {
    if (!expandedId.current) {
      setNodes(derivedNodes);
      setEdges(derivedEdges);
    }
  }, [derivedNodes, derivedEdges, setNodes, setEdges]);

  useEffect(() => {
    if (workflowCount > prevCount.current) {
      prevCount.current = workflowCount;
      setTimeout(() => fitView({ duration:500, padding:0.1 }), 80);
    }
  }, [workflowCount, fitView]);

  // When the mouse enters a node that has a file list, shift all nodes
  // in the same workflow row that sit below it by FILE_LIST_SHIFT px.
  const handleNodeMouseEnter = useCallback((_, node) => {
    if (!node.data?.fileList?.length || expandedId.current) return;
    expandedId.current = node.id;
    const wfId  = node.data?.workflowId;
    const nodeY = node.position.y;
    setNodes(prev => prev.map(n =>
      n.data?.workflowId === wfId && n.position.y > nodeY
        ? { ...n, position: { ...n.position, y: n.position.y + FILE_LIST_SHIFT } }
        : n
    ));
  }, [setNodes]);

  // When the mouse leaves the expanded node, reverse the shift.
  const handleNodeMouseLeave = useCallback((_, node) => {
    if (expandedId.current !== node.id) return;
    expandedId.current = null;
    const wfId  = node.data?.workflowId;
    const nodeY = node.position.y;
    setNodes(prev => prev.map(n =>
      n.data?.workflowId === wfId && n.position.y > nodeY
        ? { ...n, position: { ...n.position, y: n.position.y - FILE_LIST_SHIFT } }
        : n
    ));
  }, [setNodes]);

  const combinedNodesChange = useCallback((changes) => { handleNodesChange(changes); onNodesChange(changes); }, [handleNodesChange, onNodesChange]);
  const handleDragOver = useCallback(e => { e.preventDefault(); e.dataTransfer.dropEffect="move"; }, []);
  const handleDrop = useCallback(e => {
    e.preventDefault();
    const toolId = e.dataTransfer.getData("application/reactflow-tool");
    const tool = TOOL_CATALOG.find(t => t.id===toolId);
    if (!tool) return;
    onDropTool(tool, screenToFlowPosition({ x:e.clientX, y:e.clientY }));
  }, [screenToFlowPosition, onDropTool]);

  return (
    <div
      className="canvas-frame"
      ref={canvasRef}
      style={canvasH ? { height: canvasH } : {}}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
                 onNodesChange={combinedNodesChange} onEdgesChange={handleEdgesChange}
                 onConnect={onConnect} onNodeClick={onNodeClick}
                 onNodeDoubleClick={onNodeDoubleClick}
                 onNodeDragStop={onNodeDragStop}
                 onNodeMouseEnter={handleNodeMouseEnter}
                 onNodeMouseLeave={handleNodeMouseLeave}
                 fitView fitViewOptions={{ padding:0.12 }} minZoom={0.12}>
        <Background color="#d7d0c3" gap={24} size={1.2} />
        <Controls position="bottom-left" />
      </ReactFlow>
    </div>
  );
}

// ─── sidebar helpers ──────────────────────────────────────────────────────────

function Stat({ label, value, icon: Icon }) {
  return (
    <div className="stat">
      <Icon size={17} />
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}
function CategoryPill({ label, count }) {
  const Icon = CATEGORY_META[label]?.icon || Archive;
  return (
    <span className={`category-pill tone-${CATEGORY_META[label]?.tone||"other"}`}>
      <Icon size={15}/>{label}<strong>{count}</strong>
    </span>
  );
}
function ToolPaletteItem({ tool }) {
  const Icon = tool.icon || Layers3;
  const onDragStart = e => { e.dataTransfer.setData("application/reactflow-tool", tool.id); e.dataTransfer.effectAllowed="move"; };
  return (
    <button className="tool-item" type="button" draggable onDragStart={onDragStart}>
      <span className={`tool-icon tone-${tool.tone}`}><Icon size={16}/></span>
      <span><strong>{tool.label}</strong><small>{tool.category}·{tool.subtitle}</small></span>
    </button>
  );
}
function createToolNode(tool, position, sequence) {
  if (tool.id === "sticky-note") {
    return { id: `sticky-${sequence}-${Date.now()}`, type: "stickyNote", position,
      data: { text: "Double-click to edit…", colorIdx: 0 } };
  }
  return { id:`tool-${tool.id}-${sequence}`, type:"workflowNode", position,
    data:{ label:tool.label, subtitle:tool.subtitle, icon:tool.icon, tone:tool.tone,
           status:"Ready", metrics:[{label:"Tool",value:tool.category}],
           note:tool.note, customToolId:tool.id, custom:true } };
}
function normalizeDirectoryFiles(fileList) {
  return Array.from(fileList).map(f => ({
    name:f.name, path:f.webkitRelativePath||f.name, size:f.size,
    type:f.type||"", lastModified:f.lastModified, category:classifyFile(f.name), fileObject:f,
  }));
}
const EMPTY_WF = () => ({ id:`wf-${Date.now()}`, folderName:"", files:[], customToolNodes:[], manualEdges:[], runState:"idle", pythonNodeCode:{} });

// ─── resizable hook ───────────────────────────────────────────────────────────
// Returns [size | null, onMouseDown, ref].
// size is null until first drag; first drag reads offsetWidth/Height from ref.
function useResizableEl(axis = "y", min = 60, max = 500) {
  const [size, setSize] = useState(null);
  const elRef = useRef(null);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = elRef.current;
    const startPos  = axis === "x" ? e.clientX : e.clientY;
    const startSize = el ? (axis === "x" ? el.offsetWidth : el.offsetHeight) : Math.round((min + max) / 2);
    document.body.style.cursor     = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
      setSize(Math.min(max, Math.max(min, startSize + delta)));
    };
    const onUp = () => {
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, [axis, min, max]);

  return [size, onMouseDown, elRef];
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const fallbackInputRef = useRef(null);
  const pendingNewWf = useRef(false);

  const [workflowList, setWorkflowList]   = useState(() => { const w=EMPTY_WF(); return [w]; });
  const [activeWorkflowId, setActiveWorkflowId] = useState(() => workflowList[0].id);
  const [search, setSearch]               = useState("");
  const [toolSearch, setToolSearch]       = useState("");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [status, setStatus]               = useState({ type:"idle", text:"Connect a local folder to generate a workflow canvas." });
  const [previewFile, setPreviewFile]     = useState(null);
  const [fileChanges, setFileChanges]     = useState({});
  const [pythonPanel, setPythonPanel]         = useState(null);
  const [localAgentPanel, setLocalAgentPanel] = useState(null);
  const [ideOpener,   setIdeOpener]           = useState(null);
  const [toolPanel,   setToolPanel]           = useState(null);
  const [showTemplates,  setShowTemplates]  = useState(false);
  const [showPalette,    setShowPalette]    = useState(false);
  const [showAIProvider, setShowAIProvider] = useState(false);
  const [workflowVars,   setWorkflowVars]   = useState({});
  const importFileRef = useRef(null);
  const [showDashboard, setShowDashboard]     = useState(false);
  const [aiSuggest, setAiSuggest]             = useState(null);
  const [lastPythonOutput, setLastPythonOutput] = useState({});
  const [outputDisplayPanel, setOutputDisplayPanel] = useState(null);

  // ── resize handles ────────────────────────────────────────────────────────
  const [sidebarW,   sidebarResizeDown,  sidebarRef]  = useResizableEl("x", 240, 560);
  const [paletteH,   paletteResizeDown,  paletteRef]  = useResizableEl("y",  80, 520);
  const [privacyH,   privacyResizeDown,  privacyRef]  = useResizableEl("y",  48, 320);
  const [workflowRH, workflowResizeDown, workflowRef] = useResizableEl("y",  48, 320);

  // canvas ↕ resize (divider between canvas and file panel)
  const [canvasH, setCanvasH] = useState(null);
  const canvasFrameRef = useRef(null);

  const makeDividerDown = useCallback((ref, setter, min = 100, max = 1400) => (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = ref.current?.offsetHeight ?? Math.round((min + max) / 2);
    document.body.style.cursor     = "ns-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => setter(Math.min(max, Math.max(min, startH + ev.clientY - startY)));
    const onUp   = () => {
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, []);

  const onCanvasDividerDown  = useMemo(() => makeDividerDown(canvasFrameRef,  setCanvasH,  200, 1200), [makeDividerDown]);

  // preview window height (divider below it)
  const [previewH, setPreviewH]   = useState(null);
  const previewWindowRef          = useRef(null);
  const onPreviewDividerDown      = useMemo(() => makeDividerDown(previewWindowRef, setPreviewH, 120, 900), [makeDividerDown]);

  // scanned-files panel height (divider below it)
  const [filePanelH, setFilePanelH] = useState(null);
  const filePanelRef                = useRef(null);
  const onFilePanelDividerDown      = useMemo(() => makeDividerDown(filePanelRef, setFilePanelH, 120, 900), [makeDividerDown]); // { [workflowId]: [{type,excerpt,timestamp,fileName}] }

  const activeWorkflow  = useMemo(() => workflowList.find(w=>w.id===activeWorkflowId)??workflowList[0], [workflowList,activeWorkflowId]);
  const workflowSummary = useMemo(() => summarizeFiles(activeWorkflow.files), [activeWorkflow.files]);

  // ── workflow list mutators ────────────────────────────────────────────────

  const updateWorkflow = useCallback((id, patch) => {
    setWorkflowList(prev => prev.map(w => w.id===id ? { ...w,...(typeof patch==="function"?patch(w):patch) } : w));
  }, []);
  const addWorkflow = useCallback(data => {
    const nw = { ...EMPTY_WF(), ...data };
    setWorkflowList(prev => [...prev, nw]);
    setActiveWorkflowId(nw.id);
    return nw.id;
  }, []);
  const removeWorkflow = useCallback(id => {
    setWorkflowList(prev => {
      const next = prev.filter(w => w.id!==id);
      if (!next.length) { const f=EMPTY_WF(); setActiveWorkflowId(f.id); return [f]; }
      setActiveWorkflowId(cur => cur!==id?cur:next[next.length-1].id);
      return next;
    });
    // Free all per-workflow caches so the GC can reclaim notebook outputs,
    // python results, file edits, etc. Without this they accumulate forever.
    setFileChanges(prev => { const n={...prev}; delete n[id]; return n; });
    setLastPythonOutput(prev => { const n={...prev}; delete n[id]; return n; });
  }, []);

  // ── combined canvas ───────────────────────────────────────────────────────

  const { nodes: rawNodes, edges: derivedEdges } = useMemo(
    () => buildCombinedCanvas(workflowList, activeWorkflowId, fileChanges),
    [workflowList, activeWorkflowId, fileChanges],
  );

  // ── file preview & annotation ─────────────────────────────────────────────

  const handleFileOpen = useCallback(async (fileEntry, workflowId) => {
    let file;
    try {
      if (fileEntry.handle)           file = await fileEntry.handle.getFile();
      else if (fileEntry.fileObject)  file = fileEntry.fileObject;
      else { setStatus({ type:"warning", text:"Re-scan the folder to enable file preview." }); return; }
    } catch { setStatus({ type:"error", text:"Permission expired — re-scan the folder." }); return; }

    // Revoke the previous preview's blob URL so the underlying file data can be
    // garbage-collected. Without this, every PDF/image you open stays in memory
    // until the tab is closed.
    setPreviewFile(prev => {
      if (prev?.blobUrl) { try { URL.revokeObjectURL(prev.blobUrl); } catch {} }
      return prev;
    });

    const ext = extensionOf(file.name);
    const name = file.name;

    if (IMAGE_EXTS.has(ext)) {
      const blobUrl = URL.createObjectURL(file);
      setPreviewFile({ name, ext, type:"image", blobUrl, workflowId });
      setStatus({ type:"success", text:`Opened ${name}` });
    } else if (ext===".pdf") {
      const blobUrl = URL.createObjectURL(file);
      setPreviewFile({ name, ext, type:"pdf", blobUrl, workflowId });
      setStatus({ type:"success", text:`Opened ${name}` });
    } else if (ext===".docx"||ext===".doc") {
      try {
        setStatus({ type:"info", text:`Converting ${name}…` });
        const buf    = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer:buf });
        setPreviewFile({ name, ext, type:"html", html:result.value, workflowId });
        setStatus({ type:"success", text:`Opened ${name}` });
      } catch { setStatus({ type:"error", text:`Could not convert ${name}.` }); }
    } else if (ext === ".py") {
      try {
        const text = await file.text();
        setPreviewFile({ name, ext, type:"code", content:text, workflowId });
        setStatus({ type:"success", text:`Opened ${name}` });
      } catch { setStatus({ type:"error", text:`Could not read ${name}.` }); }
    } else if (ext === ".ipynb") {
      try {
        const text = await file.text();
        setPreviewFile({ name, ext, type:"notebook", content:text, workflowId });
        setStatus({ type:"success", text:`Opened ${name}` });
      } catch { setStatus({ type:"error", text:`Could not read ${name}.` }); }
    } else if (ext === ".pptx" || ext === ".ppt") {
      try {
        setStatus({ type:"info", text:`Converting ${name}…` });
        const buf = await file.arrayBuffer();
        // Encode as base64 in chunks to avoid stack overflow on large files
        const u8 = new Uint8Array(buf);
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < u8.length; i += CHUNK) binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
        const base64 = btoa(binary);
        const res = await fetch(`${BACKEND_URL}/api/pptx/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: base64 }),
        });
        const result = await res.json();
        if (result.type === "pdf") {
          const pdfBytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
          const blob = new Blob([pdfBytes], { type: "application/pdf" });
          setPreviewFile({ name, ext, type:"pdf", blobUrl:URL.createObjectURL(blob), workflowId });
          setStatus({ type:"success", text:`Opened ${name} (PDF conversion)` });
        } else if (result.type === "slides") {
          setPreviewFile({ name, ext, type:"pptx", slides:result.slides, workflowId });
          setStatus({ type:"success", text:`Opened ${name} · ${result.slides.length} slides` });
        } else {
          throw new Error("unsupported");
        }
      } catch {
        const blobUrl = URL.createObjectURL(file);
        setPreviewFile({ name, ext, type:"unsupported", blobUrl, workflowId });
        setStatus({ type:"info", text:`${name} — install LibreOffice or python-pptx for inline preview.` });
      }
    } else {
      const blobUrl = URL.createObjectURL(file);
      setPreviewFile({ name, ext, type:"unsupported", blobUrl, workflowId });
      setStatus({ type:"info", text:`${name} cannot be previewed inline — use Download.` });
    }
  }, []);

  const handleAnnotationAdded = useCallback((entry) => {
    const wfId = previewFile?.workflowId || activeWorkflowId;
    setFileChanges(prev => ({
      ...prev,
      [wfId]: [...(prev[wfId]||[]), entry],
    }));
  }, [previewFile, activeWorkflowId]);

  // ── sticky note callbacks (must be before derivedNodes useMemo) ──────────

  const updateStickyText = useCallback((nodeId, text) => {
    updateWorkflow(activeWorkflowId, w => ({
      customToolNodes: w.customToolNodes.map(n =>
        n.id === nodeId ? { ...n, data: { ...n.data, text } } : n
      ),
    }));
  }, [activeWorkflowId, updateWorkflow]);

  const updateStickyColor = useCallback((nodeId, colorIdx) => {
    updateWorkflow(activeWorkflowId, w => ({
      customToolNodes: w.customToolNodes.map(n =>
        n.id === nodeId ? { ...n, data: { ...n.data, colorIdx } } : n
      ),
    }));
  }, [activeWorkflowId, updateWorkflow]);

  const deleteStickyNote = useCallback((nodeId) => {
    updateWorkflow(activeWorkflowId, w => ({
      customToolNodes: w.customToolNodes.filter(n => n.id !== nodeId),
    }));
  }, [activeWorkflowId, updateWorkflow]);

  // ── inject callbacks into derived nodes ──────────────────────────────────

  const derivedNodes = useMemo(() =>
    rawNodes.map(n => {
      if (n.type === "workflowHeader") return { ...n, data: { ...n.data, onRemove: removeWorkflow } };
      if (n.type === "workflowNode")   return { ...n, data: { ...n.data, onFileOpen: handleFileOpen } };
      if (n.type === "stickyNote")     return { ...n, data: { ...n.data,
        onTextChange:  updateStickyText,
        onColorChange: updateStickyColor,
        onDelete:      deleteStickyNote,
      }};
      return n;
    }),
    [rawNodes, removeWorkflow, handleFileOpen, updateStickyText, updateStickyColor, deleteStickyNote],
  );

  // ── folder scanning ───────────────────────────────────────────────────────

  const connectWithDirectoryPicker = useCallback(async (targetId) => {
    const id = targetId??activeWorkflowId;
    if (!("showDirectoryPicker" in window)) {
      pendingNewWf.current = !targetId;
      fallbackInputRef.current?.click();
      return;
    }
    try {
      setStatus({ type:"info", text:"Waiting for folder permission…" });
      const handle = await window.showDirectoryPicker({ mode:"read" });
      const collected = await scanFolderHandle(handle);
      if (targetId==="new") addWorkflow({ folderName:handle.name, files:collected });
      else updateWorkflow(id, { folderName:handle.name, files:collected, runState:"idle" });
      setStatus({ type:"success", text:`Loaded ${collected.length} files from "${handle.name}".` });
    } catch(err) {
      if (err?.name!=="AbortError") setStatus({ type:"error", text:`Could not read folder: ${err?.message}` });
      else setStatus({ type:"warning", text:"Folder access cancelled." });
    }
  }, [activeWorkflowId, addWorkflow, updateWorkflow]);

  const handleFallbackFiles = useCallback(e => {
    const selected = normalizeDirectoryFiles(e.target.files||[]);
    const folder = selected[0]?.path?.split("/")?.[0]||"Selected folder";
    if (pendingNewWf.current) addWorkflow({ folderName:folder, files:selected });
    else updateWorkflow(activeWorkflowId, { folderName:folder, files:selected, runState:"idle" });
    setStatus({ type:selected.length?"success":"warning",
                text:selected.length?`Loaded ${selected.length} files from "${folder}".`:"No files selected." });
    e.target.value="";
  }, [activeWorkflowId, addWorkflow, updateWorkflow]);

  // ── AI suggest ────────────────────────────────────────────────────────────

  const handleAISuggest = useCallback(async () => {
    setAiSuggest({ loading: true });
    try {
      const res = await fetch(`${BACKEND_URL}/api/ai/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: workflowSummary,
          folderName: activeWorkflow.folderName,
          files: activeWorkflow.files.slice(0, 50).map(({ name, category, size }) => ({ name, category, size })),
        }),
      });
      const data = await res.json();
      if (!res.ok) setAiSuggest({ error: data.error || "Request failed", hint: data.hint });
      else setAiSuggest({ suggestions: data.suggestions || [], analysis: data.analysis });
    } catch (err) {
      setAiSuggest({ error: `Cannot reach backend at ${BACKEND_URL}. Start the workflow engine:\n  cd workflow-engine && node server.js` });
    }
  }, [workflowSummary, activeWorkflow]);

  // ── node interactions ─────────────────────────────────────────────────────

  const handleNodeDrillDown = useCallback(async (wfId, nodeData, files, folderName) => {
    if (nodeData.tone==="trigger") { connectWithDirectoryPicker("new"); }
    else if (nodeData.category) {
      const filtered = files.filter(f => f.category===nodeData.category);
      if (!filtered.length) return;
      addWorkflow({ folderName:`${folderName}›${nodeData.category}`, files:filtered });
      setStatus({ type:"success", text:`Opened ${filtered.length} ${nodeData.category} files as new workflow.` });
    }
  }, [connectWithDirectoryPicker, addWorkflow]);

  const handleNodeClick = useCallback((_,node) => {
    if (!node.data?.workflowId) return;
    setActiveWorkflowId(node.data.workflowId);
    if (node.data?.drillable) {
      const wf = workflowList.find(w => w.id===node.data.workflowId);
      if (wf) handleNodeDrillDown(wf.id, node.data, wf.files, wf.folderName);
    }
  }, [workflowList, handleNodeDrillDown]);

  const TOOL_PANEL_IDS = new Set([
    "web-research","api-request","document-extractor","table-analyzer",
    "data-cleaner","chart-builder","classifier","insight-summarizer","report-writer",
  ]);

  const handleNodeDoubleClick = useCallback((_,node) => {
    const wfId   = node.data?.workflowId ?? activeWorkflowId;
    const toolId = node.data?.customToolId;
    setActiveWorkflowId(wfId);

    // Base workflow nodes
    if (node.data?.label === "Local AI Agent" || node.id?.endsWith("|agent")) {
      setLocalAgentPanel({ workflowId: wfId });
      return;
    }

    // Custom tool nodes
    if (toolId === "python-step" || node.data?.label === "Python Analysis Step" || node.data?.label === "Python / IDE Opener") {
      setIdeOpener({ workflowId: wfId });
    } else if (toolId === "output-display" || node.data?.label === "Output Display") {
      setOutputDisplayPanel({ workflowId: wfId });
    } else if (toolId === "ai-suggest" || node.data?.label === "AI Workflow Suggest") {
      handleAISuggest();
    } else if (toolId && TOOL_PANEL_IDS.has(toolId)) {
      setToolPanel({ toolId, workflowId: wfId });
    }
  }, [activeWorkflowId, handleAISuggest]);

  const handleConnect = useCallback(connection => {
    const p = connection.source.indexOf("|");
    if (p===-1) return;
    const wfId   = connection.source.slice(0,p);
    const origSrc = connection.source.slice(p+1);
    const origTgt = connection.target.slice(connection.target.indexOf("|")+1);
    const edge = { id:`manual-${origSrc}-${origTgt}-${Date.now()}`, source:origSrc, target:origTgt,
                   type:"smoothstep", animated:true,
                   markerEnd:{type:MarkerType.ArrowClosed,width:18,height:18},
                   style:{strokeWidth:2.3} };
    updateWorkflow(wfId, w => ({ manualEdges:addEdge(edge,w.manualEdges) }));
    setStatus({ type:"success", text:"Connected two workflow nodes." });
  }, [updateWorkflow]);

  const handleNodeDragStop = useCallback((_,node) => {
    if (!node.data?.custom||!node.data?.workflowId) return;
    const { workflowId:wfId, nodeYOffset:yOff=0 } = node.data;
    const origId = node.id.slice(wfId.length+1);
    updateWorkflow(wfId, w => ({
      customToolNodes: w.customToolNodes.map(n => n.id===origId?{...n,position:{x:node.position.x,y:node.position.y-yOff}}:n),
    }));
  }, [updateWorkflow]);

  // ── tool palette ──────────────────────────────────────────────────────────

  const handleDropTool = useCallback((tool, position) => {
    updateWorkflow(activeWorkflowId, w => {
      const seq = w.customToolNodes.length+1;
      return { customToolNodes:[...w.customToolNodes, createToolNode(tool,position,seq)] };
    });
    setStatus({ type:"success", text:`Added "${tool.label}" to the canvas.` });
  }, [activeWorkflowId, updateWorkflow]);

  const addToolToCanvas = useCallback(tool => {
    updateWorkflow(activeWorkflowId, w => {
      const seq = w.customToolNodes.length+1;
      return { customToolNodes:[...w.customToolNodes, createToolNode(tool,{x:980,y:420+(seq%4)*80},seq)] };
    });
    setStatus({ type:"success", text:`Added "${tool.label}" to the active canvas.` });
  }, [activeWorkflowId, updateWorkflow]);

  const clearCustomTools = useCallback(() => {
    const ids = new Set(activeWorkflow.customToolNodes.map(n=>n.id));
    updateWorkflow(activeWorkflowId, w => ({
      customToolNodes:[], manualEdges:w.manualEdges.filter(e=>!ids.has(e.source)&&!ids.has(e.target)),
    }));
    setStatus({ type:"info", text:"Removed custom tool nodes." });
  }, [activeWorkflow, activeWorkflowId, updateWorkflow]);

  const handleAISuggestAdd = useCallback((toolId) => {
    const tool = TOOL_CATALOG.find(t => t.id === toolId);
    if (tool) { addToolToCanvas(tool); setStatus({ type:"success", text:`Added "${tool.label}" to canvas.` }); }
    setAiSuggest(null);
  }, [addToolToCanvas]);

  // ── templates ─────────────────────────────────────────────────────────────

  const handleTemplateSelect = useCallback((template) => {
    const nw = EMPTY_WF();
    if (template) {
      // Build tool nodes at the positions defined in the template layout
      const toolNodeIds = template.tools.map((toolId, i) => `tool-${toolId}-${i + 1}`);
      const toolNodes = template.tools.map((toolId, i) => {
        const tool = TOOL_CATALOG.find(t => t.id === toolId);
        if (!tool) return null;
        const pos = template.layout?.[i] ?? { x: 300 + i * 310, y: 450 };
        return {
          id: toolNodeIds[i],
          type: "workflowNode",
          position: pos,
          data: {
            label: tool.label, subtitle: tool.subtitle, icon: tool.icon, tone: tool.tone,
            status: "Ready", metrics: [{ label: "Tool", value: tool.category }],
            note: tool.note, customToolId: tool.id, custom: true,
          },
        };
      }).filter(Boolean);

      // Build edges from the template's edge definitions
      // {from/to} is either a base node string ("folder","scanner","router","agent")
      // or a 0-based index into tools[] resolved to the generated node id
      const resolveRef = (ref) =>
        typeof ref === "number" ? toolNodeIds[ref] : ref;

      const manualEdges = (template.edges ?? []).map((e, i) => ({
        id: `tpl-${template.id}-edge-${i}`,
        source: resolveRef(e.from),
        target: resolveRef(e.to),
        type: "smoothstep",
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
        style: { strokeWidth: 2.3 },
      }));

      nw.folderName = template.label;
      nw.customToolNodes = toolNodes;
      nw.manualEdges    = manualEdges;
    }
    setWorkflowList(prev => [...prev, nw]);
    setActiveWorkflowId(nw.id);
    setStatus({ type: "success", text: template ? `Started "${template.label}" template.` : "Blank workflow added." });
  }, []);

  // ── sticky notes ───────────────────────────────────────────────────────────

  const addStickyNote = useCallback(() => {
    updateWorkflow(activeWorkflowId, w => {
      const seq = w.customToolNodes.length + 1;
      return { customToolNodes: [...w.customToolNodes, {
        id: `sticky-${seq}-${Date.now()}`, type: "stickyNote",
        position: { x: 400, y: 180 },
        data: { text: "Double-click to edit…", colorIdx: 0 },
      }]};
    });
  }, [activeWorkflowId, updateWorkflow]);

  // ── import ─────────────────────────────────────────────────────────────────

  const handleImport = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const nw = EMPTY_WF();
        nw.folderName = data.folderName || data.name || "Imported workflow";
        // Restore custom tool nodes from the exported workflow nodes
        if (data.workflow?.nodes) {
          nw.customToolNodes = data.workflow.nodes
            .filter(n => n.type === "workflowNode" && n.data?.custom)
            .map(n => ({ ...n, id: `tool-imported-${n.id}-${Date.now()}` }));
        }
        setWorkflowList(prev => [...prev, nw]);
        setActiveWorkflowId(nw.id);
        setStatus({ type: "success", text: `Imported "${nw.folderName}".` });
      } catch {
        setStatus({ type: "error", text: "Invalid workflow JSON." });
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }, []);

  // ── Keyboard shortcut: Ctrl+K → command palette ────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setShowPalette(p => !p); }
      if (e.key === "Escape") { setShowPalette(false); setShowTemplates(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── simulate / export ─────────────────────────────────────────────────────

  const simulateRun = useCallback(() => {
    if (!activeWorkflow.files.length) { setStatus({ type:"warning", text:"Connect a folder before simulating." }); return; }
    updateWorkflow(activeWorkflowId, { runState:"running" });
    setStatus({ type:"info", text:"Simulating…" });
    window.setTimeout(() => {
      updateWorkflow(activeWorkflowId, { runState:"complete" });
      setStatus({ type:"success", text:`Simulation complete — ${activeWorkflow.files.length} files routed.` });
    }, 900);
  }, [activeWorkflow, activeWorkflowId, updateWorkflow]);

  const exportWorkflow = useCallback(() => {
    const edits  = fileChanges[activeWorkflowId] || [];
    const built  = buildWorkflow(activeWorkflow.files, activeWorkflow.folderName, activeWorkflow.runState, activeWorkflow.customToolNodes, edits);
    const payload = { app:"local-n8n-agent-workflow-ui", folderName:activeWorkflow.folderName,
                      generatedAt:new Date().toISOString(), files:activeWorkflow.files,
                      fileEdits:edits, summary:built.summary,
                      workflow:toExportableWorkflow({...built,edges:[...built.edges,...activeWorkflow.manualEdges]}) };
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"),{href:url,download:"local-agent-workflow.json"}).click();
    URL.revokeObjectURL(url);
    setStatus({ type:"success", text:"Exported local-agent-workflow.json." });
  }, [activeWorkflow, activeWorkflowId, fileChanges]);

  // ── derived UI data ───────────────────────────────────────────────────────

  const filteredTools = useMemo(() => {
    const q=toolSearch.trim().toLowerCase();
    return q?TOOL_CATALOG.filter(t=>[t.label,t.category,t.subtitle].some(v=>v.toLowerCase().includes(q))):TOOL_CATALOG;
  }, [toolSearch]);

  const sortedFiles = useMemo(() => {
    const q=search.trim().toLowerCase();
    const v=q?activeWorkflow.files.filter(f=>f.path.toLowerCase().includes(q)||f.category.toLowerCase().includes(q)):activeWorkflow.files;
    return v.slice(0,120);
  }, [activeWorkflow.files,search]);

  const topExtensionsText = useMemo(() => {
    if (!workflowSummary.topExtensions.length) return "None yet";
    return workflowSummary.topExtensions.slice(0,4).map(i=>`${i.extension} (${i.count})`).join(", ");
  }, [workflowSummary.topExtensions]);

  const previewChangeLog = previewFile ? (fileChanges[previewFile.workflowId]||[]).filter(e=>e.fileName===previewFile.name) : [];

  // ── render ────────────────────────────────────────────────────────────────

  const sw = sidebarW ?? 370;

  return (
    <main
      className={`app-shell ${isSidebarOpen?"":"sidebar-collapsed"}`}
      style={{ gridTemplateColumns: isSidebarOpen ? `${sw}px 6px minmax(0,1fr)` : `0 0 minmax(0,1fr)` }}
    >
      <button className="sidebar-toggle floating" type="button" onClick={()=>setIsSidebarOpen(o=>!o)}
        aria-expanded={isSidebarOpen} title={isSidebarOpen?"Hide left panel":"Show left panel"}>
        {isSidebarOpen?<PanelLeftClose size={19}/>:<PanelLeftOpen size={19}/>}
      </button>

      <aside className="sidebar" ref={sidebarRef} style={{ width: sw }} aria-label="Workflow controls">
        <div className="sidebar-topbar">
          <div className="brand">
            <span className="brand-mark"><Sparkles size={20}/></span>
            <span><strong>Local Agent Studio</strong><small>Folder to workflow builder</small></span>
          </div>
          <button className="sidebar-toggle inline" type="button" onClick={()=>setIsSidebarOpen(false)} title="Hide panel">
            <PanelLeftClose size={17}/> Hide
          </button>
        </div>

        <div className="sidebar-action-card">
          <button className="button primary sidebar-connect" type="button" onClick={()=>connectWithDirectoryPicker()}>
            <FolderOpen size={18}/> Connect local folder
          </button>
          <input ref={fallbackInputRef} className="visually-hidden" type="file" webkitdirectory="" directory="" multiple onChange={handleFallbackFiles}/>

          <div className="sidebar-action-grid">
            <button className="button secondary" type="button" onClick={() => setShowTemplates(true)}>
              <Sparkles size={15}/> Template
            </button>
            <button className="button secondary ai-suggest-btn" type="button"
                    onClick={handleAISuggest} disabled={!activeWorkflow.files.length}>
              <Sparkles size={15}/> Suggest
            </button>
            <button className="button secondary" type="button" onClick={simulateRun} disabled={!activeWorkflow.files.length}>
              <Play size={16}/> Simulate
            </button>
            <button className="button secondary" type="button" onClick={exportWorkflow} disabled={!activeWorkflow.files.length}>
              <Download size={16}/> Export
            </button>
          </div>

          <button className={`button secondary ai-cfg-open-btn${showAIProvider ? " active" : ""}`} type="button"
                  onClick={() => setShowAIProvider(v => !v)}>
            <Settings size={15}/> AI model
            {showAIProvider ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
          </button>
          {showAIProvider && <AIProviderPanel onClose={() => setShowAIProvider(false)} />}
        </div>

        <section
          className="tool-palette"
          ref={paletteRef}
          style={paletteH !== null ? { flex:"none", height:paletteH } : {}}
          aria-label="Agent tool palette"
        >
          <div className="palette-head">
            <div><strong>Agent tools</strong><small>Drag tools onto the canvas</small></div>
            <button className="icon-button" type="button" onClick={clearCustomTools} disabled={!activeWorkflow.customToolNodes.length}>Clear</button>
          </div>
          <label className="palette-search">
            <Search size={15}/>
            <input value={toolSearch} onChange={e=>setToolSearch(e.target.value)} placeholder="Search tools"/>
          </label>
          <div className="tool-list">
            {filteredTools.map(tool=>(
              <div className="tool-row" key={tool.id}>
                <ToolPaletteItem tool={tool}/>
                <button className="add-tool-button" type="button" onClick={()=>addToolToCanvas(tool)}>Add</button>
              </div>
            ))}
          </div>
          <div className="section-resize-handle" onMouseDown={paletteResizeDown} title="Drag to resize" />
        </section>

        <div className="sidebar-utility-stack">
          <details
            className={`panel sidebar-accordion${privacyH !== null ? " panel--fixed" : ""}`}
            ref={privacyRef}
            style={privacyH !== null ? { flex:"none", height:privacyH, overflow:"hidden" } : {}}
          >
            <summary className="panel-title"><LockKeyhole size={16}/>Privacy<ChevronDown size={13}/></summary>
            <p>This app runs in your browser on localhost. It reads folder metadata only and does not upload files.</p>
            <div className="section-resize-handle" onMouseDown={privacyResizeDown} title="Drag to resize" />
          </details>

          <details
            className={`panel sidebar-accordion compact${workflowRH !== null ? " panel--fixed" : ""}`}
            ref={workflowRef}
            style={workflowRH !== null ? { flex:"none", height:workflowRH, overflow:"hidden" } : {}}
          >
            <summary className="panel-title"><SlidersHorizontal size={16}/>Workflow rules<ChevronDown size={13}/></summary>
            <p>Files are routed by extension into Documents, Code, Images, Data, or Other branches.</p>
            <p className="extension-list">{topExtensionsText}</p>
            <div className="section-resize-handle" onMouseDown={workflowResizeDown} title="Drag to resize" />
          </details>
          <WorkflowVariablesPanel variables={workflowVars} onChange={setWorkflowVars} />
        </div>

        <div className={`status status-${status.type}`} role="status">
          {status.type==="success"?<CheckCircle2 size={17}/>:status.type==="error"?<XCircle size={17}/>:<Info size={17}/>}
          <span>{status.text}</span>
        </div>
      </aside>

      {/* Always keep resize bar in DOM so workspace always lands in the 3rd grid column */}
      <div className={`sidebar-resize-bar${isSidebarOpen ? "" : " sidebar-resize-bar--hidden"}`}
           onMouseDown={isSidebarOpen ? sidebarResizeDown : undefined}
           title="Drag to resize sidebar" />

      <section className="workspace" aria-label="Generated workflow workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">n8n-inspired local workflow</p>
            <h1 className="workspace-title">Visual agent workflow</h1>
          </div>
          <div className="stats-grid" aria-label="Folder summary">
            <Stat label="Folder"     value={activeWorkflow.folderName||"None"} icon={HardDrive}/>
            <Stat label="Files"      value={workflowSummary.fileCount}          icon={FileSearch}/>
            <Stat label="Total size" value={workflowSummary.totalSize}          icon={Database}/>
          </div>
          <div className="topbar-actions">
            <button
              className="button secondary exec-log-toggle"
              type="button"
              onClick={() => setLocalAgentPanel({ workflowId: activeWorkflow.id })}
              title="Open Local AI Agent task panel"
            >
              <Bot size={16}/> Agent Task
            </button>
            <button
              className={`button secondary exec-log-toggle${showDashboard?" exec-log-toggle--active":""}`}
              type="button"
              onClick={() => setShowDashboard(v => !v)}
              title="Toggle execution log"
            >
              <Activity size={16}/> {showDashboard ? "Hide Log" : "Exec Log"}
            </button>
          </div>
        </header>

        <section className="category-strip" aria-label="Detected file categories">
          {Object.entries(workflowSummary.categories).map(([cat,count])=>(
            <CategoryPill key={cat} label={cat} count={count}/>
          ))}
        </section>

        <CanvasToolbar
          onAddNote={addStickyNote}
          onFitView={() => document.querySelector(".react-flow__controls-fitview")?.click()}
          onSearch={() => setShowPalette(true)}
          onTemplate={() => setShowTemplates(true)}
          onImport={() => importFileRef.current?.click()}
        />
        <input ref={importFileRef} type="file" accept=".json" className="visually-hidden" onChange={handleImport} />

        <ReactFlowProvider>
          <AppCanvas
            derivedNodes={derivedNodes} derivedEdges={derivedEdges}
            workflowCount={workflowList.length}
            canvasH={canvasH} canvasRef={canvasFrameRef}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onConnect={handleConnect}
            onNodeDragStop={handleNodeDragStop} onDropTool={handleDropTool}
            onNodesChange={()=>{}} onEdgesChange={()=>{}}
          />
        </ReactFlowProvider>

        {ideOpener && (
          <IDEOpenerPanel
            workflow={workflowList.find(w => w.id === ideOpener.workflowId) ?? activeWorkflow}
            onClose={() => setIdeOpener(null)}
          />
        )}

        {toolPanel && (
          <ToolPanel
            toolId={toolPanel.toolId}
            workflow={workflowList.find(w => w.id === toolPanel.workflowId) ?? activeWorkflow}
            onClose={() => setToolPanel(null)}
          />
        )}

        {localAgentPanel && (
          <LocalAgentPanel
            workflow={workflowList.find(w => w.id === localAgentPanel.workflowId) ?? activeWorkflow}
            onRunComplete={(result) => setLastPythonOutput(prev => ({
              ...prev, [localAgentPanel.workflowId]: result
            }))}
            onOpenOutput={() => setOutputDisplayPanel({ workflowId: localAgentPanel.workflowId })}
            onClose={() => setLocalAgentPanel(null)}
          />
        )}

        {pythonPanel && (
          <PythonPanel
            workflow={workflowList.find(w => w.id === pythonPanel.workflowId) ?? activeWorkflow}
            nodeId={pythonPanel.nodeId}
            initialCode={(workflowList.find(w => w.id === pythonPanel.workflowId)?.pythonNodeCode ?? {})[pythonPanel.nodeId] ?? PYTHON_STARTER}
            onCodeChange={(nid, code) => updateWorkflow(pythonPanel.workflowId, w => ({
              pythonNodeCode: { ...w.pythonNodeCode, [nid]: code }
            }))}
            onRunComplete={(result) => setLastPythonOutput(prev => ({
              ...prev, [pythonPanel.workflowId]: result
            }))}
            onClose={() => setPythonPanel(null)}
          />
        )}

        {outputDisplayPanel && (
          <OutputDisplayPanel
            workflowId={outputDisplayPanel.workflowId}
            lastOutput={lastPythonOutput}
            workflow={workflowList.find(w => w.id === outputDisplayPanel.workflowId) ?? activeWorkflow}
            onClose={() => setOutputDisplayPanel(null)}
          />
        )}

        {showDashboard && <ExecDashboard onClose={() => setShowDashboard(false)} />}

        <div
          className="h-divider"
          onMouseDown={onCanvasDividerDown}
          title="Drag to resize canvas"
          role="separator"
          aria-label="Resize canvas height"
        />

        {previewFile && (
          <>
            <ResizableSides>
              <div ref={previewWindowRef}>
                <FileViewerWindow
                  file={previewFile}
                  changeLog={previewChangeLog}
                  height={previewH}
                  onClose={()=>{
                    // Revoke blob URL on close so PDF/image bytes can be freed
                    if (previewFile?.blobUrl) {
                      try { URL.revokeObjectURL(previewFile.blobUrl); } catch {}
                    }
                    setPreviewFile(null);
                    setPreviewH(null);
                  }}
                  onAnnotationAdded={handleAnnotationAdded}
                />
              </div>
            </ResizableSides>

            <div className="h-divider" onMouseDown={onPreviewDividerDown}
                 title="Drag to resize" role="separator" aria-label="Resize preview window height" />
          </>
        )}

        <ResizableSides>
          <section
            className="file-panel"
            ref={filePanelRef}
            style={filePanelH ? { height: filePanelH, overflow:"hidden", display:"flex", flexDirection:"column" } : {}}
            aria-label="Scanned files"
          >
            <div className="file-panel-head">
              <div>
                <h2>Scanned files</h2>
                <p>{activeWorkflow.files.length
                  ?`${sortedFiles.length} shown from ${activeWorkflow.files.length} local metadata records`
                  :"No folder connected yet"}</p>
              </div>
              <label className="search-box">
                <Search size={17}/>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search path or category"/>
              </label>
            </div>
            <div className="file-table" style={filePanelH ? { flex:1, maxHeight:"none" } : {}}>
              <div className="file-row table-head"><span>Path</span><span>Category</span><span>Size</span><span>Modified</span></div>
              {sortedFiles.map(f=>(
                <div className="file-row" key={`${f.path}-${f.size}-${f.lastModified}`}>
                  <span title={f.path}>{f.path}</span><span>{f.category}</span>
                  <span>{formatBytes(f.size)}</span>
                  <span>{f.lastModified?new Date(f.lastModified).toLocaleDateString():"Unknown"}</span>
                </div>
              ))}
              {!activeWorkflow.files.length&&(
                <div className="empty-state">
                  <Upload size={25}/>
                  <strong>Connect a folder to begin.</strong>
                  <span>Your browser will ask for permission before any local metadata is read.</span>
                </div>
              )}
            </div>
          </section>
        </ResizableSides>

        <div className="h-divider" onMouseDown={onFilePanelDividerDown}
             title="Drag to resize" role="separator" aria-label="Resize file panel height" />

        <footer className="footer-note">
          <ShieldCheck size={16}/>
          Local-first prototype. The exported workflow JSON is generated in the browser.
        </footer>
      </section>
      {aiSuggest && (
        <AISuggestPanel
          result={aiSuggest}
          onAddTool={handleAISuggestAdd}
          onClose={() => setAiSuggest(null)}
        />
      )}

      {showTemplates && (
        <WorkflowTemplatesModal
          onSelect={handleTemplateSelect}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {showPalette && (
        <CommandPalette
          onAddTool={(tool) => { addToolToCanvas(tool); setStatus({ type:"success", text:`Added "${tool.label}".`}); }}
          onClose={() => setShowPalette(false)}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
