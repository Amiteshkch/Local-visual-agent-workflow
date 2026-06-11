// server.js — Workflow Engine Backend
// Run: node server.js   (or: npm run dev for auto-restart)
// API: http://localhost:3001

const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const { exec }  = require("child_process");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { v4: uuidv4 } = require("uuid");
const os     = require("os");
const fsp    = require("fs").promises;
const crypto = require("crypto");
const fetch  = require("node-fetch");

const execAsync = promisify(exec);

// ─── Storage — prefer SQLite, fall back to file-based ─────────────────────────
let storage;
try {
  storage = require("./storage/sqlite");
  console.log("[Storage] SQLite");
} catch (e) {
  storage = require("./storage");
  console.log("[Storage] File-based (install better-sqlite3 to use SQLite):", e.message);
}

const { executeWorkflow } = require("./engine/executor");
const { executePython }   = require("./engine/nodes");
const Scheduler = require("./engine/scheduler");
const {
  detectCLIs,
  callClaudeCLI,
  callCodexCLI,
  callGeminiCLI,
  cleanCLIOutput,
} = require("./engine/cliProviders");

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "16mb" })); // larger limit for PPTX base64

// ─── Scheduler ────────────────────────────────────────────────────────────────
const scheduler = new Scheduler(storage);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), scheduledJobs: scheduler.status().length });
});

// ── Open in IDE ───────────────────────────────────────────────────────────────
// Resolves a folder name to its absolute path.
// On macOS: uses Spotlight (mdfind) — instant, searches the entire home directory.
// Fallback: checks Desktop, Documents, Downloads, Projects, etc.
app.post("/api/resolve-path", async (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: "folderName required" });

  const HOME = os.homedir();
  const safeName = folderName.replace(/"/g, '\\"').replace(/`/g, "");
  const found = [];

  // ── 1. Google Drive / iCloud / OneDrive (CloudStorage) ───────────────────
  // This is the most common case on macOS for users with cloud-synced folders.
  const cloudStorage = path.join(HOME, "Library", "CloudStorage");
  try {
    const { stdout: findOut } = await execAsync(
      `find "${cloudStorage}" -name "${safeName.replace(/"/g, '\\"')}" -type d -maxdepth 8 2>/dev/null | head -20`,
      { timeout: 8000 }
    );
    for (const p of findOut.trim().split("\n").filter(Boolean)) {
      if (path.basename(p) === folderName) found.push(p);
    }
  } catch {}

  if (found.length) return res.json({ found: true, path: found[0], alternatives: found });

  // ── 2. macOS Spotlight (covers Desktop, Documents, Downloads, etc.) ───────
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execAsync(
        `mdfind -onlyin "${HOME}" 'kMDItemFSName == "${safeName}"cd && kMDItemContentType == "public.folder"' 2>/dev/null | head -10`,
        { timeout: 5000 }
      );
      for (const p of stdout.trim().split("\n").filter(Boolean)) {
        try {
          const stat = await fsp.stat(p);
          if (stat.isDirectory() && path.basename(p) === folderName) found.push(p);
        } catch {}
      }
    } catch {}
  }

  if (found.length) return res.json({ found: true, path: found[0], alternatives: found });

  // ── 3. Common locations fallback ──────────────────────────────────────────
  const commonDirs = [
    path.join(HOME, "Desktop",   folderName),
    path.join(HOME, "Documents", folderName),
    path.join(HOME, "Downloads", folderName),
    path.join(HOME, "Projects",  folderName),
    path.join(HOME, "dev",       folderName),
    path.join(HOME,              folderName),
  ];
  for (const p of commonDirs) {
    try {
      const stat = await fsp.stat(p);
      if (stat.isDirectory()) return res.json({ found: true, path: p, alternatives: [p] });
    } catch {}
  }

  res.json({ found: false, suggestions: commonDirs.slice(0, 3) });
});

// Opens a folder (and optionally a file) in the requested IDE.
// ide: "vscode" | "cursor" | "zed" | "jupyterlab" | "pycharm"
app.post("/api/open-in-ide", async (req, res) => {
  const { workspacePath, filePath, ide = "vscode" } = req.body;
  if (!workspacePath) return res.status(400).json({ error: "workspacePath required" });

  const COMMANDS = {
    vscode:     (ws, fp) => fp ? `code "${ws}" "${fp}"` : `code "${ws}"`,
    cursor:     (ws, fp) => fp ? `cursor "${ws}" "${fp}"` : `cursor "${ws}"`,
    zed:        (ws, fp) => fp ? `zed "${fp}"` : `zed "${ws}"`,
    jupyterlab: (ws)     => `jupyter lab "${ws}"`,
    pycharm:    (ws, fp) => `open -na "PyCharm.app" --args "${fp ?? ws}"`,
  };

  const fn = COMMANDS[ide];
  if (!fn) return res.status(400).json({ error: `Unknown IDE: ${ide}` });

  const cmd = fn(workspacePath, filePath || null);

  try {
    // Fire-and-forget — IDE starts in background; don't wait for it to exit.
    const child = require("child_process").exec(cmd, { timeout: 8000 });
    child.unref();
    // Give it 1 s to surface an immediate error (command not found, etc.)
    await new Promise(r => setTimeout(r, 1000));
    res.json({ success: true, command: cmd });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, command: cmd });
  }
});

// ── Python Analysis Step ──────────────────────────────────────────────────────
app.post("/api/python/run", async (req, res) => {
  const { code = "", files = [], previousOutput = null, timeout = 30 } = req.body;
  if (!code.trim()) return res.status(400).json({ error: "No code provided." });
  try {
    const result = await executePython(code, files, previousOutput, Math.min(timeout, 120));
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PPTX Preview ─────────────────────────────────────────────────────────────
// Accepts { data: base64string } — returns { type: "pdf"|"slides"|"unsupported" }
// type=pdf:    { data: base64PDF }   → rendered with PDF.js on the frontend
// type=slides: { slides: [{index, text}] } → text-only slide cards
app.post("/api/pptx/preview", async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "No data provided" });

  const tag    = crypto.randomBytes(8).toString("hex");
  const tmpIn  = path.join(os.tmpdir(), `pptx_in_${tag}.pptx`);
  const tmpOut = path.join(os.tmpdir(), `pptx_out_${tag}`);

  await fsp.writeFile(tmpIn, Buffer.from(data, "base64"));

  const cleanup = () => Promise.all([
    fsp.unlink(tmpIn).catch(() => {}),
    fsp.rm(tmpOut, { recursive: true, force: true }).catch(() => {}),
  ]);

  // 1) Try LibreOffice (converts to PDF — best fidelity)
  try {
    await fsp.mkdir(tmpOut, { recursive: true });
    await execAsync(`soffice --headless --convert-to pdf "${tmpIn}" --outdir "${tmpOut}"`, { timeout: 30000 });
    const files    = await fsp.readdir(tmpOut);
    const pdfFile  = files.find(f => f.endsWith(".pdf"));
    if (pdfFile) {
      const pdfBuf = await fsp.readFile(path.join(tmpOut, pdfFile));
      await cleanup();
      return res.json({ type: "pdf", data: pdfBuf.toString("base64") });
    }
  } catch (_) { /* LibreOffice not available */ }

  // 2) Try python-pptx (text extraction)
  let pyBin = null;
  for (const bin of ["python3", "python"]) {
    try { require("child_process").execSync(`${bin} --version`, { stdio: "ignore" }); pyBin = bin; break; }
    catch {}
  }

  if (pyBin) {
    const pyScript = path.join(os.tmpdir(), `pptx_reader_${tag}.py`);
    const pyCode = `import sys, json
from pptx import Presentation
prs = Presentation(sys.argv[1])
slides = []
for i, slide in enumerate(prs.slides, 1):
    texts = []
    for shape in slide.shapes:
        if hasattr(shape, "text") and shape.text.strip():
            texts.append(shape.text.strip())
    slides.append({"index": i, "text": "\\n".join(texts)})
print(json.dumps(slides))
`;
    await fsp.writeFile(pyScript, pyCode);

    const pyResult = await new Promise(resolve => {
      const proc = spawn(pyBin, [pyScript, tmpIn]);
      let stdout = "", stderr = "";
      proc.stdout.on("data", d => { stdout += d; });
      proc.stderr.on("data", d => { stderr += d; });
      const killer = setTimeout(() => { proc.kill(); resolve({ ok: false }); }, 15000);
      proc.on("close", code => {
        clearTimeout(killer);
        try { resolve(code === 0 && stdout ? { ok: true, slides: JSON.parse(stdout) } : { ok: false }); }
        catch { resolve({ ok: false }); }
      });
      proc.on("error", () => resolve({ ok: false }));
    });

    await fsp.unlink(pyScript).catch(() => {});

    if (pyResult.ok) {
      await cleanup();
      return res.json({ type: "slides", slides: pyResult.slides });
    }
  }

  await cleanup();
  return res.json({ type: "unsupported" });
});

// ── AI provider helpers ───────────────────────────────────────────────────────

const GEMINI_DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const GEMINI_LEGACY_MODELS = new Set(["gemini-1.5-flash", "gemini-1.5-pro"]);

function normalizeGeminiModel(model) {
  return model && !GEMINI_LEGACY_MODELS.has(model) ? model : GEMINI_DEFAULT_MODELS[0];
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(url, { ...opts, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function listGeminiModels(apiKey) {
  if (!apiKey) return GEMINI_DEFAULT_MODELS;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) return GEMINI_DEFAULT_MODELS;
    const d = await r.json();
    const models = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    return models.length ? models : GEMINI_DEFAULT_MODELS;
  } catch {
    return GEMINI_DEFAULT_MODELS;
  }
}

async function callGemini(prompt, system, credentials, generationConfig, emptyFallback) {
  const apiKey = credentials.geminiApiKey;
  if (!apiKey) throw new Error("No Gemini API key configured. Get one at https://aistudio.google.com/app/apikey");
  const models = uniqueList([normalizeGeminiModel(credentials.geminiModel), ...GEMINI_DEFAULT_MODELS]);
  let lastError = null;
  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
      }
    );
    if (r.ok) {
      const data = await r.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || emptyFallback;
    }
    const e = await r.json().catch(() => ({}));
    lastError = new Error(e?.error?.message || `Gemini error ${r.status}`);
    if (r.status !== 404 && !/not found|not supported/i.test(lastError.message)) throw lastError;
  }
  throw lastError || new Error("No supported Gemini model was available for generateContent.");
}

// Unified AI call — switches between Ollama (local/free), Gemini (free tier), Claude (paid),
// or subscription CLIs (claude-cli / codex-cli / gemini-cli — billed against user's Pro/Max plan).
async function callAI(prompt, credentials) {
  const SYSTEM = "You are a workflow automation expert. Always reply with valid JSON only — no prose, no markdown fences.";
  const provider = credentials.aiProvider || "claude";

  // ── Subscription / CLI providers (Pro/Max/Plus billing, no raw API key) ─────
  if (provider === "claude-cli") return cleanCLIOutput(await callClaudeCLI(prompt, SYSTEM, { timeoutMs: 120000 })) || "{}";
  if (provider === "codex-cli")  return cleanCLIOutput(await callCodexCLI(prompt,  SYSTEM, { timeoutMs: 120000 })) || "{}";
  if (provider === "gemini-cli") return cleanCLIOutput(await callGeminiCLI(prompt, SYSTEM, { timeoutMs: 120000 })) || "{}";

  // ── Ollama (local, completely free) ──────────────────────────────────────────
  if (provider === "ollama") {
    const base  = (credentials.ollamaUrl  || "http://localhost:11434").replace(/\/$/, "");
    const model = credentials.ollamaModel || "llama3";
    const r = await fetchWithTimeout(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: prompt },
        ],
        stream: false,
      }),
    }, 20000);
    if (!r.ok) throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "{}";
  }

  // ── Google Gemini (free tier with API key) ────────────────────────────────────
  if (provider === "gemini") {
    return callGemini(prompt, SYSTEM, credentials, { maxOutputTokens: 800, temperature: 0.2 }, "{}");
  }

  // ── Anthropic Claude (paid) ────────────────────────────────────────────────────
  const apiKey = credentials.anthropicApiKey;
  if (!apiKey) throw new Error(
    "No AI provider configured. Choose one:\n" +
    "• Ollama (free, local): install Ollama → POST { aiProvider:'ollama' } to /api/credentials\n" +
    "• Gemini (free tier): get API key at aistudio.google.com → POST { aiProvider:'gemini', geminiApiKey:'...' }\n" +
    "• Claude (paid): POST { aiProvider:'claude', anthropicApiKey:'sk-ant-...' }"
  );
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: credentials.claudeModel || "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `Claude error ${r.status}`); }
  const data = await r.json();
  return data.content?.[0]?.text || "{}";
}

async function callAITask(prompt, credentials) {
  const SYSTEM = "You are a local AI agent working inside a visual workflow builder. Use the supplied folder summary and file excerpts to complete the user's task. Be direct, cite filenames when useful, and say when the provided context is insufficient.";
  const provider = credentials.aiProvider || "claude";

  // ── Subscription CLIs ──
  if (provider === "claude-cli") return cleanCLIOutput(await callClaudeCLI(prompt, SYSTEM, { timeoutMs: 600000 }));
  if (provider === "codex-cli")  return cleanCLIOutput(await callCodexCLI(prompt,  SYSTEM, { timeoutMs: 600000 }));
  if (provider === "gemini-cli") return cleanCLIOutput(await callGeminiCLI(prompt, SYSTEM, { timeoutMs: 600000 }));

  if (provider === "ollama") {
    const base  = (credentials.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
    const model = credentials.ollamaModel || "llama3";
    let r;
    try {
      r = await fetchWithTimeout(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
      }, 600000);
    } catch (err) {
      if (/timed out/i.test(err.message)) {
        throw new Error(
          `Ollama did not finish this agent pass within 10 minutes. ` +
          `Try fewer agents/passes, select fewer or smaller files, use a smaller Ollama model, or switch to Gemini/Claude for this run.`
        );
      }
      throw err;
    }
    if (!r.ok) throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || "";
  }

  if (provider === "gemini") {
    return callGemini(prompt, SYSTEM, credentials, { maxOutputTokens: 4096, temperature: 0.25 }, "");
  }

  const apiKey = credentials.anthropicApiKey;
  if (!apiKey) throw new Error("No AI provider configured.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: credentials.claudeModel || "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Claude error ${r.status}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text || "";
}

// ── GET /api/ai/providers — detect available providers ───────────────────────
app.get("/api/ai/providers", async (req, res) => {
  const creds = await storage.getCredentials();
  const providers = [];

  // Ollama: try to reach it
  const ollamaUrl = (creds.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
  let ollamaModels = [];
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(t);
    if (r.ok) {
      const d = await r.json();
      ollamaModels = (d.models || []).map(m => m.name);
    }
  } catch {}
  providers.push({
    id: "ollama", label: "Ollama (local, free)", available: ollamaModels.length > 0,
    models: ollamaModels.length ? ollamaModels : ["llama3", "mistral", "gemma", "phi3"],
    currentModel: creds.ollamaModel || "llama3",
    url: ollamaUrl,
    hint: ollamaModels.length ? `${ollamaModels.length} model(s) ready` : "Install Ollama and run: ollama pull llama3",
  });

  // Gemini
  const geminiModels = await listGeminiModels(creds.geminiApiKey);
  const geminiCurrent = geminiModels.includes(normalizeGeminiModel(creds.geminiModel))
    ? normalizeGeminiModel(creds.geminiModel)
    : geminiModels[0];

  providers.push({
    id: "gemini", label: "Google Gemini (free tier)", available: !!creds.geminiApiKey,
    models: geminiModels,
    currentModel: geminiCurrent,
    hint: creds.geminiApiKey ? "API key configured" : "Get free key at aistudio.google.com",
  });

  // Claude
  providers.push({
    id: "claude", label: "Anthropic Claude (paid)", available: !!creds.anthropicApiKey,
    models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"],
    currentModel: creds.claudeModel || "claude-haiku-4-5-20251001",
    hint: creds.anthropicApiKey ? "API key configured" : "Requires paid API key from console.anthropic.com",
  });

  // ── Subscription / CLI providers (use user's Pro/Max/Plus session, no API key) ──
  const clis = detectCLIs();
  providers.push({
    id: "claude-cli", label: "Claude Code CLI (Pro/Max subscription)",
    available: clis.claude.installed, models: ["subscription-default"], currentModel: "subscription-default",
    cliPath: clis.claude.path,
    hint: clis.claude.installed
      ? "Uses your logged-in Claude Code session — billed against Pro/Max quota."
      : "Install: https://docs.claude.com/en/docs/claude-code   then run: claude login",
  });
  providers.push({
    id: "codex-cli", label: "OpenAI Codex CLI (ChatGPT Plus/Pro)",
    available: clis.codex.installed, models: ["subscription-default"], currentModel: "subscription-default",
    cliPath: clis.codex.path,
    hint: clis.codex.installed
      ? "Uses your ChatGPT subscription via Codex CLI. Counts toward agentic/Codex limits."
      : "Install: npm i -g @openai/codex   then run: codex login",
  });
  providers.push({
    id: "gemini-cli", label: "Gemini CLI (Google AI Pro/Ultra)",
    available: clis.gemini.installed, models: ["subscription-default"], currentModel: "subscription-default",
    cliPath: clis.gemini.path,
    hint: clis.gemini.installed
      ? "Uses your Google AI subscription. Note: Google migrates Gemini CLI → Antigravity from 18 Jun 2026."
      : "Install: npm i -g @google/gemini-cli   then sign in with Google",
  });

  res.json({ providers, current: creds.aiProvider || "claude" });
});

// ── POST /api/ai/provider — save provider choice ──────────────────────────────
app.post("/api/ai/provider", async (req, res) => {
  const { aiProvider, ollamaUrl, ollamaModel, geminiApiKey, geminiModel, claudeModel } = req.body;
  const updates = {};
  if (aiProvider)   updates.aiProvider   = aiProvider;
  if (ollamaUrl)    updates.ollamaUrl    = ollamaUrl;
  if (ollamaModel)  updates.ollamaModel  = ollamaModel;
  if (geminiApiKey) updates.geminiApiKey = geminiApiKey;
  if (geminiModel)  updates.geminiModel  = geminiModel;
  if (claudeModel)  updates.claudeModel  = claudeModel;
  await storage.saveCredentials(updates);
  res.json({ saved: true });
});

const VALID_AI_TOOL_IDS = new Set([
  "web-research", "api-request", "document-extractor", "table-analyzer",
  "data-cleaner", "python-step", "chart-builder", "classifier",
  "insight-summarizer", "report-writer",
]);

const AI_TOOL_ALIASES = {
  "python-script-executor": "python-step",
  "python-executor": "python-step",
  "code-runner": "python-step",
  "text-summarizer": "insight-summarizer",
  "summarizer": "insight-summarizer",
  "document-reporter": "report-writer",
  "report-generator": "report-writer",
  "content-classifier": "classifier",
  "tagger": "classifier",
  "data-visualizer": "chart-builder",
  "visualizer": "chart-builder",
  "table-parser": "table-analyzer",
  "csv-analyzer": "table-analyzer",
  "document-parser": "document-extractor",
};

function inferToolId(suggestion = {}) {
  const raw = String(suggestion.toolId || "").trim().toLowerCase();
  if (VALID_AI_TOOL_IDS.has(raw)) return raw;
  if (AI_TOOL_ALIASES[raw]) return AI_TOOL_ALIASES[raw];

  const text = `${suggestion.tool || ""} ${raw} ${suggestion.reason || ""}`.toLowerCase();
  if (/\b(python|script|code)\b/.test(text)) return "python-step";
  if (/\b(summar|keyword|insight)\b/.test(text)) return "insight-summarizer";
  if (/\b(report|write|documenter)\b/.test(text)) return "report-writer";
  if (/\b(classif|tag|categor)\b/.test(text)) return "classifier";
  if (/\b(chart|plot|visual|graph)\b/.test(text)) return "chart-builder";
  if (/\b(csv|table|spreadsheet|tsv)\b/.test(text)) return "table-analyzer";
  if (/\b(pdf|doc|document|extract)\b/.test(text)) return "document-extractor";
  if (/\b(clean|quality|null|duplicate)\b/.test(text)) return "data-cleaner";
  if (/\b(web|research|scholar|arxiv|pubmed)\b/.test(text)) return "web-research";
  if (/\b(api|http|request)\b/.test(text)) return "api-request";
  return null;
}

function fallbackSuggestions(summary = {}) {
  const cats = summary.categories || {};
  const exts = new Set((summary.topExtensions || []).map(e => String(e.extension || "").toLowerCase()));
  const out = [];
  const add = (toolId, tool, reason) => out.push({ toolId, tool, reason });
  if ((cats.Code || 0) > 0 || exts.has(".py") || exts.has(".ipynb")) {
    add("python-step", "Python / IDE Opener", "Code files are present, so Python inspection or execution is likely useful.");
  }
  if ((cats.Documents || 0) > 0 || exts.has(".pdf") || exts.has(".docx")) {
    add("document-extractor", "Document Extractor", "Document files are present and should be converted into readable text.");
    add("insight-summarizer", "Insight Summarizer", "Extracted text can be summarized into keywords and high-level insights.");
  }
  if ((cats.Data || 0) > 0 || exts.has(".csv") || exts.has(".tsv") || exts.has(".xlsx")) {
    add("table-analyzer", "CSV / Table Analyzer", "Tabular files are present and can be profiled for columns and missing values.");
    add("chart-builder", "Chart Builder", "Structured data can be visualized after basic profiling.");
  }
  add("classifier", "Classifier / Tagger", "File type classification helps organize the folder before deeper analysis.");
  add("report-writer", "Report Writer", "A final report can collect the selected workflow outputs.");
  return out;
}

function normalizeAiSuggestions(parsed = {}, summary = {}) {
  const seen = new Set();
  const suggestions = [];
  for (const s of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    const toolId = inferToolId(s);
    if (!toolId || seen.has(toolId)) continue;
    seen.add(toolId);
    suggestions.push({
      toolId,
      tool: s.tool || toolId,
      reason: s.reason || "Suggested based on the folder contents.",
    });
  }
  for (const s of fallbackSuggestions(summary)) {
    if (suggestions.length >= 5) break;
    if (seen.has(s.toolId)) continue;
    seen.add(s.toolId);
    suggestions.push(s);
  }
  return { ...parsed, suggestions: suggestions.slice(0, 5) };
}

function clampAgentIterations(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(6, Math.round(n)));
}

function normalizeAgentSpecs({ task, iterations, agents }) {
  const specs = Array.isArray(agents) ? agents : [];
  const normalized = specs
    .slice(0, 6)
    .map((agent, idx) => ({
      id: String(agent.id || `agent-${idx + 1}`).slice(0, 40),
      name: String(agent.name || `Agent ${idx + 1}`).slice(0, 80),
      task: String(agent.task || "").trim(),
      iterations: clampAgentIterations(agent.iterations ?? iterations),
    }))
    .filter(agent => agent.task);

  if (normalized.length) return normalized;
  if (String(task || "").trim()) {
    return [{
      id: "agent-1",
      name: "Coordinator",
      task: String(task).trim(),
      iterations: clampAgentIterations(iterations),
    }];
  }
  return [];
}

function buildAgentTaskContext({ task, folderName, summary, fileBlocks, catLines }) {
  return `User task:
${task}

Folder:
${folderName}

Folder summary:
- Total files: ${summary.fileCount || 0}
- Total size: ${summary.totalSize || "unknown"}
- Categories: ${catLines || "none"}
- Top extensions: ${(summary.topExtensions || []).map(e => `${e.extension} (${e.count})`).join(", ") || "none"}

Readable file context:
${fileBlocks.length ? fileBlocks.join("\n\n") : "(No file excerpts were included. Use the summary only.)"}`;
}

async function runIterativeAgent({ baseContext, task, credentials, iterations, agentName = "Agent", onProgress }) {
  const phases = [
    "Orient: identify what the folder appears to contain and what the task requires.",
    "Inspect: extract evidence from filenames, file types, and provided excerpts.",
    "Plan: choose the workflow actions or analysis route that should be taken next.",
    "Draft: produce the concrete work product, commands, script outline, report outline, or decision.",
    "Review: check gaps, assumptions, risks, and whether more files or execution are needed.",
    "Finalize: turn the work into a concise answer the user can act on.",
  ];
  const steps = [];

  for (let i = 0; i < iterations; i += 1) {
    const title = phases[Math.min(i, phases.length - 1)];
    const previous = steps.length
      ? steps.map(s => `Step ${s.index}: ${s.title}\n${s.output}`).join("\n\n")
      : "(none)";
    onProgress?.({ phase: "pass-start", pass: i + 1, total: iterations, title });
    const prompt = `${baseContext}

You are ${agentName}, running an iterative local workflow-agent loop.
Iteration: ${i + 1} of ${iterations}
Current phase: ${title}

Previous iteration notes:
${previous}

For this iteration:
- Work only on the current phase.
- Use concrete filenames or file types when evidence exists.
- If the context is insufficient, state exactly what is missing.
- End with "Next action:" and one concrete next action.`;
    const passStart = Date.now();
    const output = await callAITask(prompt, credentials);
    const passMs = Date.now() - passStart;
    steps.push({ index: i + 1, title, output: output.trim() });
    onProgress?.({ phase: "pass-complete", pass: i + 1, total: iterations, title, durationMs: passMs });
  }

  onProgress?.({ phase: "agent-final-call" });
  const finalPrompt = `${baseContext}

The agent has completed these iterations:
${steps.map(s => `Step ${s.index}: ${s.title}\n${s.output}`).join("\n\n")}

Write the final answer to the user's task:
${task}

Return a practical result, not just a summary. Include:
1. What you concluded.
2. The exact next workflow steps.
3. Any files used or files that still need inspection.
4. Clear limits or assumptions.`;

  const answer = await callAITask(finalPrompt, credentials);
  return { answer, steps };
}

async function runAgentTeam({ baseContext, coordinatorTask, agents, credentials, onProgress }) {
  const results = [];
  const totalAgents = agents.length;

  for (let agentIdx = 0; agentIdx < agents.length; agentIdx++) {
    const agent = agents[agentIdx];
    onProgress?.({
      phase: "agent-start",
      agentId: agent.id, agentName: agent.name, agentTask: agent.task,
      agentIndex: agentIdx + 1, totalAgents, agentIterations: agent.iterations,
    });

    const agentContext = `${baseContext}

Agent assignment:
- Agent: ${agent.name}
- Task: ${agent.task}

Stay within this assignment. Other agents may handle different tasks.`;

    try {
      const agentStart = Date.now();
      const { answer, steps } = await runIterativeAgent({
        baseContext: agentContext,
        task: agent.task,
        credentials,
        iterations: agent.iterations,
        agentName: agent.name,
        // Forward per-pass events from the iterative agent up to the caller
        onProgress: (e) => onProgress?.({
          ...e,
          agentId: agent.id, agentName: agent.name,
          agentIndex: agentIdx + 1, totalAgents,
        }),
      });

      results.push({ id: agent.id, name: agent.name, task: agent.task, iterations: agent.iterations, steps, answer });
      onProgress?.({
        phase: "agent-complete",
        agentId: agent.id, agentName: agent.name,
        agentIndex: agentIdx + 1, totalAgents,
        durationMs: Date.now() - agentStart,
      });
    } catch (err) {
      results.push({
        id: agent.id, name: agent.name, task: agent.task, iterations: agent.iterations,
        steps: [], answer: `Agent stopped before completing: ${err.message}`, error: err.message,
      });
      onProgress?.({ phase: "agent-error", agentId: agent.id, agentName: agent.name, message: err.message });
    }
  }

  if (results.length === 1) {
    return {
      answer: results[0].answer,
      agents: results,
      steps: results[0].steps,
    };
  }

  const synthesisPrompt = `${baseContext}

Coordinator task:
${coordinatorTask}

Specialist agent outputs:
${results.map(agent => `## ${agent.name}
Task: ${agent.task}
Passes: ${agent.iterations}
Answer:
${agent.answer}`).join("\n\n")}

Synthesize the specialist outputs into one practical final answer. Resolve conflicts, remove duplication, and produce concrete workflow steps.`;

  onProgress?.({ phase: "synthesizing", totalAgents });
  let answer;
  try {
    answer = await callAITask(synthesisPrompt, credentials);
  } catch (err) {
    answer = `The multi-agent run produced partial results, but the coordinator synthesis could not complete: ${err.message}

Completed agent outputs:
${results.map(agent => `- ${agent.name}: ${agent.error ? `failed (${agent.error})` : agent.answer}`).join("\n")}`;
  }
  return {
    answer,
    agents: results,
    steps: results.flatMap(agent => agent.steps.map(step => ({
      ...step,
      agentId: agent.id,
      agentName: agent.name,
    }))),
  };
}

// ── AI Workflow Suggestion ────────────────────────────────────────────────────
app.post("/api/ai/suggest", async (req, res) => {
  const { summary = {}, folderName = "Unnamed", files = [] } = req.body;
  const credentials = await storage.getCredentials();

  const catLines = Object.entries(summary.categories || {})
    .filter(([, c]) => c > 0).map(([cat, count]) => `  ${cat}: ${count} file${count !== 1 ? "s" : ""}`).join("\n");
  const extLines = (summary.topExtensions || []).slice(0, 5)
    .map(e => `${e.extension} (${e.count})`).join(", ");

  const prompt = `Folder: "${folderName}"
Total files: ${summary.fileCount || 0} · Total size: ${summary.totalSize || "?"}
Categories:\n${catLines || "  (none)"}
Top extensions: ${extLines || "none"}
Sample filenames: ${files.slice(0, 8).map(f => f.name).join(", ")}

Return JSON only — no markdown:
{
  "analysis": "<2 sentences: what this folder is and what the workflow should accomplish>",
  "suggestions": [
    { "tool": "<display name>", "toolId": "<id>", "reason": "<one specific sentence>" }
  ]
}
Valid toolIds: web-research, api-request, document-extractor, table-analyzer, data-cleaner, python-step, chart-builder, classifier, insight-summarizer, report-writer
Pick the 3–5 most relevant. Prioritise based on file types actually present.`;

  try {
    const text = await callAI(prompt, credentials);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "AI returned unparseable response", raw: text });
    return res.json({ ...normalizeAiSuggestions(JSON.parse(match[0]), summary), provider: credentials.aiProvider || "claude" });
  } catch (err) {
    return res.json({
      analysis: `Using rule-based suggestions because the configured AI provider did not respond: ${err.message}`,
      suggestions: fallbackSuggestions(summary).slice(0, 5),
      provider: credentials.aiProvider || "claude",
      fallback: true,
      warning: err.message,
    });
  }
});

// ── /api/ai/build-workflow — AI Workflow Copilot ─────────────────────────────
// Turns a plain-English goal into a validated workflow spec (catalog nodes +
// edges) the studio can drop on the canvas and run. Mirrors /api/ai/suggest.
const COPILOT_VALID_IDS = new Set([
  "trigger-manual", "trigger-schedule", "trigger-webhook",
  "web-research", "api-request", "document-extractor", "table-analyzer",
  "if-else", "filter", "loop", "merge", "wait",
  "data-cleaner", "code-js", "set-variable", "text-formatter",
  "python-step", "chart-builder", "classifier", "insight-summarizer",
  "claude-ai", "ai-suggest", "report-writer", "output-display", "slack-notify",
]);

function buildFallbackWorkflow(summary = {}, goal = "") {
  const cats = summary.categories || {};
  const nodes = [{ toolId: "trigger-manual", label: "Manual Trigger" }];
  if ((cats.Documents || 0) > 0) nodes.push({ toolId: "document-extractor", label: "Document Extractor" }, { toolId: "insight-summarizer", label: "Insight Summarizer" });
  if ((cats.Data || 0) > 0) nodes.push({ toolId: "table-analyzer", label: "CSV / Table Analyzer" }, { toolId: "data-cleaner", label: "Data Cleaner" });
  if (nodes.length === 1) nodes.push({ toolId: "classifier", label: "Classifier / Tagger" });
  nodes.push({ toolId: "report-writer", label: "Report Writer" }, { toolId: "output-display", label: "Output Display" });
  const edges = nodes.slice(1).map((_, i) => [i, i + 1]);
  return { name: goal.slice(0, 60) || "Suggested workflow", nodes, edges };
}

app.post("/api/ai/build-workflow", async (req, res) => {
  const { goal = "", folderName = "Unnamed", summary = {}, files = [] } = req.body;
  if (!String(goal).trim()) return res.status(400).json({ error: "A goal is required." });
  const credentials = await storage.getCredentials();

  const catLines = Object.entries(summary.categories || {})
    .filter(([, c]) => c > 0).map(([cat, count]) => `  ${cat}: ${count}`).join("\n");

  const prompt = `You are a workflow architect for a local visual agent builder. Convert the user's goal into a runnable node graph.

User goal: "${goal}"
Folder: "${folderName}" — ${summary.fileCount || 0} files
Categories:\n${catLines || "  (none)"}
Sample files: ${files.slice(0, 8).map(f => f.name).join(", ") || "none"}

Return JSON only — no markdown:
{
  "name": "<short workflow name>",
  "nodes": [ { "toolId": "<id>", "label": "<display name>" } ],
  "edges": [ [fromIndex, toIndex] ]
}
Rules:
- "edges" reference node positions in the "nodes" array (0-based), wiring the data flow in order.
- Start with a trigger node (usually "trigger-manual") and end with "output-display".
- Use 3–7 nodes. Only choose toolIds from this list:
  trigger-manual, trigger-schedule, trigger-webhook, web-research, api-request, document-extractor,
  table-analyzer, if-else, filter, loop, merge, wait, data-cleaner, code-js, set-variable, text-formatter,
  python-step, chart-builder, classifier, insight-summarizer, claude-ai, ai-suggest, report-writer,
  output-display, slack-notify
- Pick nodes that match the file types actually present.`;

  try {
    const text = await callAI(prompt, credentials);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI returned an unparseable response");
    const parsed = JSON.parse(match[0]);
    const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    // Keep only valid nodes; remap edges to the filtered index space.
    const keep = [], indexMap = {};
    rawNodes.forEach((n, i) => {
      if (n && COPILOT_VALID_IDS.has(n.toolId)) { indexMap[i] = keep.length; keep.push({ toolId: n.toolId, label: n.label || n.toolId }); }
    });
    const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
      .map(e => Array.isArray(e) ? [indexMap[e[0]], indexMap[e[1]]] : null)
      .filter(e => e && e[0] != null && e[1] != null && e[0] !== e[1]);
    if (!keep.length) throw new Error("No valid nodes produced");
    return res.json({ name: parsed.name || goal.slice(0, 60), nodes: keep, edges, provider: credentials.aiProvider || "claude" });
  } catch (err) {
    return res.json({ ...buildFallbackWorkflow(summary, goal), provider: credentials.aiProvider || "claude", fallback: true, warning: err.message });
  }
});

app.post("/api/ai/task", async (req, res) => {
  const { task = "", folderName = "Unnamed", summary = {}, files = [], iterations = 4, agents = [], provider } = req.body;
  // Per-request provider override (set by a model node on the studio canvas);
  // unsupported values fall back to the stored provider.
  const storedCredentials = await storage.getCredentials();
  const credentials = ["claude", "gemini", "ollama"].includes(provider)
    ? { ...storedCredentials, aiProvider: provider }
    : storedCredentials;
  const agentSpecs = normalizeAgentSpecs({ task, iterations, agents });
  if (!agentSpecs.length) return res.status(400).json({ error: "At least one task or agent task is required." });

  const catLines = Object.entries(summary.categories || {})
    .filter(([, c]) => c > 0)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(", ");
  let budget = 70000;
  const fileBlocks = [];
  for (const f of files.slice(0, 20)) {
    if (budget <= 0) break;
    const raw = String(f.content || "");
    const text = raw.slice(0, Math.min(raw.length, budget, 12000));
    budget -= text.length;
    fileBlocks.push(`### ${f.path || f.name}
Category: ${f.category || "Other"} | Size: ${f.size || 0} bytes${f.contentTruncated ? " | truncated" : ""}

${text || "(No readable text extracted.)"}`);
  }

  const coordinatorTask = String(task || "").trim() || agentSpecs.map(a => `${a.name}: ${a.task}`).join("\n");
  const baseContext = buildAgentTaskContext({ task: coordinatorTask, folderName, summary, fileBlocks, catLines });

  try {
    const run = await runAgentTeam({
      baseContext,
      coordinatorTask,
      credentials,
      agents: agentSpecs,
    });
    res.json({
      answer: run.answer,
      steps: run.steps,
      agents: run.agents,
      iterations: agentSpecs.reduce((sum, agent) => sum + agent.iterations, 0),
      provider: credentials.aiProvider || "claude",
      usedFiles: files.map(f => f.path || f.name).filter(Boolean),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── /api/ai/task-stream — Server-Sent Events for live progress ───────────────
// Streams events as each agent / pass starts and completes so the frontend can
// show real-time status instead of a blank "Running..." for several minutes.
//
// Events emitted (each one is `event: <name>\ndata: <json>\n\n`):
//   start          { totalAgents, totalPasses, agents:[{id,name,iterations}] }
//   progress       { phase, agentName, pass, total, title, durationMs, ... }
//   complete       { answer, agents, provider, usedFiles, generatedAt }
//   error          { message }
app.post("/api/ai/task-stream", async (req, res) => {
  const { task = "", folderName = "Unnamed", summary = {}, files = [], iterations = 4, agents = [] } = req.body;
  const credentials = await storage.getCredentials();
  const agentSpecs = normalizeAgentSpecs({ task, iterations, agents });
  if (!agentSpecs.length) return res.status(400).json({ error: "At least one task or agent task is required." });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;
  req.on("close", () => { clientClosed = true; });

  const send = (event, data) => {
    if (clientClosed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Context setup (same as POST /api/ai/task)
  const catLines = Object.entries(summary.categories || {})
    .filter(([, c]) => c > 0).map(([cat, count]) => `${cat}: ${count}`).join(", ");
  let budget = 70000;
  const fileBlocks = [];
  for (const f of files.slice(0, 20)) {
    if (budget <= 0) break;
    const raw = String(f.content || "");
    const text = raw.slice(0, Math.min(raw.length, budget, 12000));
    budget -= text.length;
    fileBlocks.push(`### ${f.path || f.name}
Category: ${f.category || "Other"} | Size: ${f.size || 0} bytes${f.contentTruncated ? " | truncated" : ""}

${text || "(No readable text extracted.)"}`);
  }
  const coordinatorTask = String(task || "").trim() || agentSpecs.map(a => `${a.name}: ${a.task}`).join("\n");
  const baseContext = buildAgentTaskContext({ task: coordinatorTask, folderName, summary, fileBlocks, catLines });

  send("start", {
    totalAgents: agentSpecs.length,
    totalPasses: agentSpecs.reduce((s, a) => s + a.iterations, 0),
    agents: agentSpecs.map(a => ({ id: a.id, name: a.name, iterations: a.iterations })),
    provider: credentials.aiProvider || "claude",
  });

  try {
    const run = await runAgentTeam({
      baseContext,
      coordinatorTask,
      credentials,
      agents: agentSpecs,
      onProgress: (event) => send("progress", event),
    });
    send("complete", {
      answer: run.answer,
      steps: run.steps,
      agents: run.agents,
      iterations: agentSpecs.reduce((sum, agent) => sum + agent.iterations, 0),
      provider: credentials.aiProvider || "claude",
      usedFiles: files.map(f => f.path || f.name).filter(Boolean),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

// ── Workflows CRUD ────────────────────────────────────────────────────────────
app.get("/api/workflows", async (req, res) => {
  try { res.json(await storage.listWorkflows()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/workflows/:id", async (req, res) => {
  try {
    const wf = await storage.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    res.json(wf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/workflows", async (req, res) => {
  try {
    const workflow = { ...req.body, id: req.body.id || uuidv4(), createdAt: new Date().toISOString() };
    await storage.saveWorkflow(workflow);
    await scheduler.refresh(workflow);
    res.status(201).json(workflow);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/workflows/:id", async (req, res) => {
  try {
    const existing = await storage.getWorkflow(req.params.id);
    if (!existing) return res.status(404).json({ error: "Workflow not found" });
    const updated = { ...existing, ...req.body, id: req.params.id };
    await storage.saveWorkflow(updated);
    await scheduler.refresh(updated);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/workflows/:id", async (req, res) => {
  try {
    await storage.deleteWorkflow(req.params.id);
    scheduler.unregister(req.params.id);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Execution ─────────────────────────────────────────────────────────────────
app.post("/api/execute/:id", async (req, res) => {
  try {
    const wf = await storage.getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    const credentials = await storage.getCredentials();
    console.log(`[API] Executing workflow "${wf.name}" (${wf.id})`);
    const log = await executeWorkflow(wf, credentials);
    await storage.saveLog(log);
    res.json(log);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/execute", async (req, res) => {
  try {
    const workflow    = { ...req.body, id: req.body.id || uuidv4() };
    const credentials = await storage.getCredentials();
    const log = await executeWorkflow(workflow, credentials);
    await storage.saveLog(log);
    res.json(log);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Webhook Trigger ───────────────────────────────────────────────────────────
app.post("/api/webhook/:path", async (req, res) => {
  try {
    const workflows = await storage.listWorkflows();
    const triggered = [];
    for (const wf of workflows) {
      const webhookNode = (wf.nodes || []).find(n => n.type === "webhook" && n.config?.path === `/${req.params.path}`);
      if (!webhookNode) continue;
      const credentials = await storage.getCredentials();
      console.log(`[Webhook] Triggering "${wf.name}" via /${req.params.path}`);
      const log = await executeWorkflow(wf, credentials, req.body);
      await storage.saveLog(log);
      triggered.push({ workflowId: wf.id, name: wf.name, status: log.status });
    }
    if (triggered.length === 0) return res.status(404).json({ error: "No workflow found for this webhook path" });
    res.json({ triggered, count: triggered.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get("/api/logs", async (req, res) => {
  try {
    const { workflowId, limit = 20 } = req.query;
    const logs = await storage.getLogs(workflowId, parseInt(limit));
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Credentials ───────────────────────────────────────────────────────────────
app.post("/api/credentials", async (req, res) => {
  try {
    await storage.saveCredentials(req.body);
    res.json({ saved: true, message: "Credentials saved server-side — used for all workflow executions" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/credentials/status", async (req, res) => {
  try {
    const creds  = await storage.getCredentials();
    const status = {};
    for (const key of Object.keys(creds)) status[key] = !!creds[key];
    res.json(status);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Researcher Scout ─────────────────────────────────────────────────────────
const RESEARCHER_RESULTS_PATH = path.join(__dirname, "storage", "researcher-results.json");

// Serve the GUI at /researcher
app.get("/researcher", (req, res) => res.sendFile(path.join(__dirname, "researcher-gui.html")));

// Read the latest scan results
app.get("/api/researcher-results", async (req, res) => {
  try {
    const raw = await fsp.readFile(RESEARCHER_RESULTS_PATH, "utf8");
    const data = JSON.parse(raw);
    const stat = await fsp.stat(RESEARCHER_RESULTS_PATH);
    res.json({ ...data, savedAt: stat.mtimeMs });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.status(404).json({ error: "No researcher results yet. Run the researcher agent first.", researchers: [] });
    }
    res.status(500).json({ error: err.message });
  }
});

// Sender profile used in all generated outreach
const SENDER_PROFILE = `
Amitesh K. Chaudhary
PhD (Mechanical Engineering), Indian Institute of Science (IISc) Bengaluru, 2018–2025
Currently: Research Associate at IISc (laser-based diagnostics of fuel jet-in-crossflow combustion)
PhD research: Rotary atomization of non-Newtonian (viscoelastic) liquids for spray drying; single-droplet evaporation modelling; high-speed shadowgraphy & PDIA; CaBER-DoS rheometry
Skills: Python (image processing, ML), MATLAB, OpenFOAM/Ansys Fluent, SolidWorks, laser diagnostics, design of experiments
Funding eligibility: Prime Minister's Research Fellow (PMRF, 2018–2023)
GitHub: github.com/Amiteshkch  ·  LinkedIn: linkedin.com/in/amitesh-kch
`.trim();

// Generate a personalised outreach email for a selected researcher
app.post("/api/generate-researcher-email", async (req, res) => {
  try {
    const { researcher } = req.body || {};
    if (!researcher || !researcher.name) return res.status(400).json({ error: "researcher object required" });

    const credentials = await storage.getCredentials();

    const prompt = `Write a concise, personalised postdoctoral inquiry email from the sender (Amitesh) to the target researcher below.

# Sender
${SENDER_PROFILE}

# Target researcher
Name:           ${researcher.name}
Institution:    ${researcher.institution || ""}
Department:     ${researcher.department || ""}
Country:        ${researcher.country || ""}
Topics:         ${(researcher.topics || []).join(", ")}
Project hint:   ${researcher.project_highlights || ""}
Required skills:${(researcher.key_skills_required || []).join(", ")}
Hiring signal:  ${researcher.hiring_signal || ""}
Funding:        ${researcher.funding_info || ""}
Suggested strategy: ${researcher.contact_strategy || ""}

# Requirements
- Tone: formal, professional, no slang, no excessive enthusiasm.
- 150–220 words for the body.
- Open by naming a specific topic from the researcher's work that overlaps with the sender's PhD.
- One paragraph on sender's relevant experience (use 1–2 concrete techniques: laser diagnostics, PDIA, rotary atomization, etc.).
- One paragraph proposing a postdoc fit and mentioning fellowship eligibility (PMRF / Newton-Bhabha / NSF / etc. as appropriate to country).
- Close with availability for a short call + CV attached.
- Do NOT invent papers, project titles, or specific dates.
- No markdown. Plain text only. Use real newlines between paragraphs.

# Output
Return ONLY a JSON object — no prose, no markdown — with exactly these keys:
{
  "subject": "string — concise, < 90 chars, of the form: Postdoc Inquiry: [Topic Match] — Amitesh Chaudhary (IISc)",
  "emailBody": "string — the full email body, starting with 'Dear Prof. <surname>,' and ending with the sender's full signature block"
}`;

    const raw = await callAITask(prompt, credentials);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "AI returned no JSON", raw });

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) { return res.status(500).json({ error: "AI JSON parse failed: " + e.message, raw }); }

    res.json({
      subject:   parsed.subject || `Postdoc Inquiry — Amitesh Chaudhary (IISc)`,
      emailBody: parsed.emailBody || "",
      to:        researcher.contact_email || "",
      provider:  credentials.aiProvider || "claude",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rewrite an existing email to sound more natural / less AI-generated
app.post("/api/humanize-email", async (req, res) => {
  try {
    const { emailBody } = req.body || {};
    if (!emailBody) return res.status(400).json({ error: "emailBody required" });

    const credentials = await storage.getCredentials();

    const prompt = `Rewrite the following postdoctoral inquiry email so it reads more like a human academic — natural cadence, slight variation in sentence length, no AI-style filler ("I hope this email finds you well", "I am writing to express my keen interest", "I would be delighted").

Keep:
- All factual content unchanged (no invented papers or dates).
- The greeting and sign-off.
- Roughly the same length (±20%).
- Plain text, real newlines between paragraphs, no markdown.

Email to rewrite:
---
${emailBody}
---

Return ONLY a JSON object — no prose — with this exact shape:
{ "emailBody": "string — the rewritten email" }`;

    const raw = await callAITask(prompt, credentials);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "AI returned no JSON", raw });

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) { return res.status(500).json({ error: "AI JSON parse failed: " + e.message, raw }); }

    res.json({ emailBody: parsed.emailBody || emailBody, provider: credentials.aiProvider || "claude" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n┌─────────────────────────────────────────────┐`);
  console.log(`│  🔶 Workflow Engine running                  │`);
  console.log(`│  API:  http://localhost:${PORT}               │`);
  console.log(`│  Docs: See README.md for all endpoints       │`);
  console.log(`└─────────────────────────────────────────────┘\n`);
  await scheduler.start();
});

module.exports = app;
