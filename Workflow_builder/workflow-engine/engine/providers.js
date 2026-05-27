// engine/providers.js
// Pluggable LLM provider chain for cron agents.
// Each provider returns { text, provider, model, latencyMs }; runWithProviderChain
// then parses JSON, validates the expected tool name, and returns the args.
// CLI providers (claude/codex/gemini) use the user's existing OAuth/subscription
// auth. Ollama hits the local HTTP API. Designed for headless cron use:
// stdin closed, hard timeout, stderr captured, classified errors.

const { spawn, spawnSync } = require("child_process");
const fetch = require("node-fetch");

// ─── Detection ────────────────────────────────────────────────────────────────
// launchd starts node with a minimal PATH, so `which` misses CLIs installed in
// ~/.local/bin or ~/.npm-global/bin. We extend PATH for detection and we record
// the absolute path so the spawn call later doesn't depend on PATH lookup.
const HOME = process.env.HOME || "";
const EXTENDED_PATH = [
  process.env.PATH || "",
  "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin",
  HOME ? `${HOME}/.local/bin` : "",
  HOME ? `${HOME}/.npm-global/bin` : "",
  HOME ? `${HOME}/.bun/bin` : "",
  HOME ? `${HOME}/.cargo/bin` : "",
  HOME ? `${HOME}/.volta/bin` : "",
].filter(Boolean).join(":");

let _detectCache = null;
function detectInstalled(force = false) {
  if (_detectCache && !force) return _detectCache;
  const env = { ...process.env, PATH: EXTENDED_PATH };
  const result = {};
  for (const cmd of ["claude", "codex", "gemini"]) {
    try {
      const r = spawnSync("which", [cmd], { encoding: "utf8", env });
      const path = (r.status === 0 && r.stdout.trim()) || "";
      result[cmd] = path || false;  // truthy = absolute path
    } catch { result[cmd] = false; }
  }
  _detectCache = result;
  return result;
}

async function detectOllama(baseUrl = "http://localhost:11434") {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return { available: false };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return { available: true, models };
  } catch { return { available: false }; }
}

// ─── Subprocess helper with timeout, closed stdin, captured stderr ────────────
function spawnWithTimeout(cmd, args, { timeoutMs = 240000, input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const tid = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, timeoutMs);
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", err => { clearTimeout(tid); reject(err); });
    child.on("close", code => {
      clearTimeout(tid);
      if (killed) return reject(new Error(`Timeout after ${timeoutMs}ms (stderr: ${stderr.slice(0, 200)})`));
      if (code !== 0) return reject(new Error(`Exit ${code}: ${(stderr || stdout).slice(0, 400)}`));
      resolve({ stdout, stderr });
    });
    if (input) try { child.stdin.write(input); } catch {}
    try { child.stdin.end(); } catch {}
  });
}

// ─── JSON extraction (handles fenced blocks, prose preambles) ─────────────────
function extractJsonObject(text) {
  if (!text || typeof text !== "string") throw new Error("Empty model response");
  let t = text.trim();
  // Strip markdown fences if model used them despite instructions
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  // Try whole-string parse first
  try { return JSON.parse(t); } catch {}
  // Find the first balanced {...} that parses (skips leading prose)
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") { if (start === -1) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = t.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch {}
        start = -1;
      }
    }
  }
  throw new Error(`No parseable JSON object found. First 200 chars: ${text.slice(0, 200)}`);
}

// ─── Per-provider implementations ─────────────────────────────────────────────

// Use the absolute path resolved by detectInstalled (or fall back to bare name)
// and pass an extended PATH so the CLI can find its own runtime (node, etc.).
function _resolved(name) {
  const installed = detectInstalled();
  return installed[name] || name;
}
const _childEnv = () => ({ ...process.env, PATH: EXTENDED_PATH });

// Empty MCP config so --strict-mcp-config disables every server.
const fs = require("fs");
const path = require("path");
const EMPTY_MCP_CONFIG_PATH = path.join(__dirname, ".empty-mcp-config.json");
try {
  if (!fs.existsSync(EMPTY_MCP_CONFIG_PATH)) fs.writeFileSync(EMPTY_MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
} catch (e) { /* non-fatal */ }

async function callClaudeCli(systemPrompt, userPrompt, opts = {}) {
  const { timeoutMs = 240000, model } = opts;
  // --print non-interactive (do NOT use --bare; it disables OAuth/keychain).
  // --system-prompt OVERRIDES Claude Code's default preamble; otherwise the
  // model sees its tool catalog (Gmail MCP, Bash, …) and tries to use them
  // because our prompt mentions "send_email_report".
  // --strict-mcp-config + empty config = no MCP servers in this run.
  // --disable-slash-commands = no skill/slash side effects.
  // --permission-mode plan = read-only, no permission prompts hang the run.
  const args = [
    "--print",
    "--system-prompt", systemPrompt,
    "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG_PATH,
    "--disable-slash-commands",
    "--permission-mode", "plan",
  ];
  if (model) args.push("--model", model);
  const t0 = Date.now();
  const { stdout } = await spawnWithTimeout(_resolved("claude"), args, { timeoutMs, env: _childEnv(), input: userPrompt });
  return { text: stdout, provider: "claude_cli", model: model || "default", latencyMs: Date.now() - t0 };
}

async function callCodexCli(systemPrompt, userPrompt, opts = {}) {
  const { timeoutMs = 240000, model } = opts;
  const args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  if (model) args.push("-c", `model="${model}"`);
  args.push(`${systemPrompt}\n\n${userPrompt}`);
  const t0 = Date.now();
  const { stdout } = await spawnWithTimeout(_resolved("codex"), args, { timeoutMs, env: _childEnv() });
  return { text: stdout, provider: "codex_cli", model: model || "default", latencyMs: Date.now() - t0 };
}

async function callGeminiCli(systemPrompt, userPrompt, opts = {}) {
  const { timeoutMs = 240000, model } = opts;
  // gemini CLI: -p / --prompt passes a one-shot prompt
  const args = ["-p", `${systemPrompt}\n\n${userPrompt}`];
  if (model) args.push("-m", model);
  const t0 = Date.now();
  const { stdout } = await spawnWithTimeout(_resolved("gemini"), args, { timeoutMs, env: _childEnv() });
  return { text: stdout, provider: "gemini_cli", model: model || "default", latencyMs: Date.now() - t0 };
}

async function callOllama(systemPrompt, userPrompt, opts = {}) {
  const { timeoutMs = 240000, model = "qwen2.5:3b", baseUrl = "http://localhost:11434" } = opts;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, system: systemPrompt, prompt: userPrompt, format: "json", stream: false, options: { num_ctx: 16384 } }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    return { text: data.response || "", provider: "ollama", model, latencyMs: Date.now() - t0 };
  } finally { clearTimeout(tid); }
}

const PROVIDERS = {
  claude_cli: callClaudeCli,
  codex_cli:  callCodexCli,
  gemini_cli: callGeminiCli,
  ollama:     callOllama,
};

// ─── Prompt rewriter: append strict JSON-output instruction for CLI providers ──
function cliSystemPrompt(originalSystem, toolName) {
  return `${originalSystem}

═════════════════════════════════════════════════════════════════
OUTPUT FORMAT — STRICT, NON-NEGOTIABLE
═════════════════════════════════════════════════════════════════
You have NO TOOLS available in this run. You CANNOT call MCP servers, Gmail,
Bash, or any external action. Your ONLY job is to emit a single JSON object as
plain text. The server will parse the JSON and perform any side effects.

Output exactly ONE JSON object with this shape (the "name" field is just a label
for our parser — it does NOT invoke anything):

{"name": "${toolName}", "args": { ... }}

The "args" object MUST contain every field described above. The main array of
analyzed items MUST contain every single item — no truncation, no "…", no
"representative samples". If the input has N items, args must have N entries.

DO NOT:
  - wrap the JSON in markdown fences (no \`\`\`json)
  - include any prose, commentary, thinking, or preamble before the JSON
  - emit multiple objects or arrays at the top level
  - use single-quoted strings (must be valid JSON)
  - attempt to actually send an email, call any tool, or invoke any MCP server
  - say "I cannot do X" — just emit the JSON

JUST the JSON object. Nothing before it. Nothing after it.`;
}

// ─── Chain runner: try each provider in order, return first success ────────────
async function runWithProviderChain({
  systemPrompt,
  userPrompt,
  expectedToolName,
  chain,
  timeoutMs = 240000,
  providerOptions = {},
  logPrefix = "[provider]",
}) {
  const installed = detectInstalled();
  const ollamaState = chain.includes("ollama") ? await detectOllama() : { available: false };
  const attempts = [];

  for (const name of chain) {
    const fn = PROVIDERS[name];
    if (!fn) { attempts.push({ provider: name, skipped: "unknown provider" }); continue; }
    if (name === "claude_cli" && !installed.claude) { attempts.push({ provider: name, skipped: "not installed" }); continue; }
    if (name === "codex_cli"  && !installed.codex)  { attempts.push({ provider: name, skipped: "not installed" }); continue; }
    if (name === "gemini_cli" && !installed.gemini) { attempts.push({ provider: name, skipped: "not installed" }); continue; }
    if (name === "ollama"     && !ollamaState.available) { attempts.push({ provider: name, skipped: "ollama not reachable on :11434" }); continue; }

    const t0 = Date.now();
    try {
      console.log(`${logPrefix} trying ${name}…`);
      const { text, latencyMs } = await fn(systemPrompt, userPrompt, { ...(providerOptions[name] || {}), timeoutMs });
      const parsed = extractJsonObject(text);
      if (expectedToolName && parsed.name && parsed.name !== expectedToolName) {
        attempts.push({ provider: name, error: `expected tool ${expectedToolName}, got ${parsed.name}`, latencyMs });
        continue;
      }
      const args = parsed.args !== undefined ? parsed.args : parsed;
      attempts.push({ provider: name, success: true, latencyMs });
      console.log(`${logPrefix} ${name} succeeded in ${latencyMs}ms`);
      return { args, providerUsed: name, attempts, latencyMs };
    } catch (err) {
      const msg = String(err.message || err).slice(0, 300);
      attempts.push({ provider: name, error: msg, latencyMs: Date.now() - t0 });
      console.warn(`${logPrefix} ${name} failed: ${msg}`);
    }
  }
  const err = new Error(`All providers failed (${chain.join("→")}). Attempts: ${JSON.stringify(attempts)}`);
  err.attempts = attempts;
  throw err;
}

module.exports = {
  detectInstalled, detectOllama,
  callClaudeCli, callCodexCli, callGeminiCli, callOllama,
  extractJsonObject, cliSystemPrompt,
  runWithProviderChain,
  PROVIDER_NAMES: Object.keys(PROVIDERS),
};
