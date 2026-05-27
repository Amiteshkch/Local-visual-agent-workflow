// ── CLI / Subscription provider wrappers ────────────────────────────────────
// Lets the workflow engine reuse the user's logged-in CLI session
// (Claude Code / OpenAI Codex / Gemini CLI) instead of raw API keys,
// so calls bill against their Pro/Max/Plus subscription quota.
//
// SAFETY: We only spawn the official CLI as a subprocess and read its stdout.
// We do not touch cookies, session files, or private tokens.

const { spawn, execSync } = require("child_process");
const path = require("path");

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

function stripAnsi(s) {
  return String(s || "").replace(ANSI_RE, "").replace(/\r/g, "");
}

// Capture the user's interactive PATH once. Node's child_process inherits a
// stripped PATH that often misses ~/.local/bin, ~/.npm-global/bin, and even
// the location of `node` itself — which breaks any CLI whose shebang is
// `#!/usr/bin/env node` (e.g. codex → "env: node: No such file or directory").
let CACHED_USER_PATH = null;
function getUserPath() {
  if (CACHED_USER_PATH !== null) return CACHED_USER_PATH;
  const loginShell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execSync(`${loginShell} -l -c 'echo $PATH'`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString().trim();
    // Prepend Node's own bin dir so `env node` always resolves
    const nodeDir = path.dirname(process.execPath);
    CACHED_USER_PATH = `${nodeDir}:${out}:${process.env.PATH || ""}`;
  } catch {
    const nodeDir = path.dirname(process.execPath);
    const home    = process.env.HOME || "";
    CACHED_USER_PATH = [
      nodeDir,
      `${home}/.local/bin`,
      `${home}/.npm-global/bin`,
      "/usr/local/bin",
      "/opt/homebrew/bin",
      process.env.PATH || "",
    ].filter(Boolean).join(":");
  }
  return CACHED_USER_PATH;
}

function spawnEnv() {
  return { ...process.env, PATH: getUserPath(), NO_COLOR: "1", FORCE_COLOR: "0" };
}

// Resolve via the user's login shell so we pick up their .zshrc/.bashrc PATH
// (Node's child_process otherwise inherits a stripped PATH that misses
// ~/.local/bin, ~/.npm-global/bin, etc.)
function which(cmd) {
  const loginShell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execSync(`${loginShell} -l -c 'command -v ${cmd}'`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString().trim();
    return out || null;
  } catch {
    // Fallback: check common install locations directly
    const home = process.env.HOME || "";
    const candidates = [
      `${home}/.local/bin/${cmd}`,
      `${home}/.npm-global/bin/${cmd}`,
      `/usr/local/bin/${cmd}`,
      `/opt/homebrew/bin/${cmd}`,
    ];
    for (const p of candidates) {
      try {
        execSync(`test -x "${p}"`, { stdio: "ignore" });
        return p;
      } catch {}
    }
    return null;
  }
}

// Detect which CLIs are installed and reachable
function detectCLIs() {
  const claudePath = which("claude");
  const codexPath  = which("codex");
  const geminiPath = which("gemini");
  return {
    claude: { installed: !!claudePath, path: claudePath },
    codex:  { installed: !!codexPath,  path: codexPath  },
    gemini: { installed: !!geminiPath, path: geminiPath },
  };
}

// Cache resolved paths so we spawn the right binary every time
const CLI_PATHS = {};
function resolve(cmd) {
  if (!CLI_PATHS[cmd]) CLI_PATHS[cmd] = which(cmd) || cmd;
  return CLI_PATHS[cmd];
}

// Spawn helper — pipes the prompt via stdin to avoid OS arg-length limits
function runCLI(cmd, args, stdinText, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv(),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${cmd} CLI did not respond within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        return reject(new Error(`${cmd} CLI not installed or not on PATH`));
      }
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return;
      const cleanOut = stripAnsi(stdout);
      const cleanErr = stripAnsi(stderr);
      if (code !== 0) {
        const combined = cleanErr + "\n" + cleanOut;
        // Friendly mapping of common provider-side errors
        if (/not authenticated|not logged in|login required|unauthori[sz]ed/i.test(combined)) {
          return reject(new Error(
            `${cmd} CLI is not logged in. Run \`${cmd} login\` in your terminal first.`
          ));
        }
        if (/usage limit|rate limit|quota|too many requests|429/i.test(combined)) {
          const resetMatch = combined.match(/try again[^\n]*?(\w+ \d+(?:st|nd|rd|th)?[^\n]*?\d{1,2}:\d{2}[^\n]*?(?:AM|PM)?)/i);
          const resetInfo  = resetMatch ? `  Resets: ${resetMatch[1].trim()}` : "";
          return reject(new Error(
            `${cmd.split("/").pop()} subscription quota exceeded.${resetInfo}\n` +
            `This is your provider's per-period limit, not an app bug. ` +
            `Switch to a different provider (API-key mode or a different CLI) or wait for the quota to reset.`
          ));
        }
        if (/not inside a trusted directory|--skip-git-repo-check/i.test(combined)) {
          return reject(new Error(
            `${cmd} refused to run outside a trusted directory. The workflow engine should be passing --skip-git-repo-check — please report this.`
          ));
        }
        return reject(new Error(`${cmd} exited ${code}: ${cleanErr || cleanOut || "no output"}`));
      }
      resolve(cleanOut);
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

// ── Claude Code (Anthropic Pro/Max subscription) ──
// `claude -p` runs in print/non-interactive mode and reads prompt from stdin.
async function callClaudeCLI(prompt, system, { timeoutMs = 180000 } = {}) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  return runCLI(resolve("claude"), ["-p"], fullPrompt, timeoutMs);
}

// ── OpenAI Codex CLI (ChatGPT Plus/Pro subscription) ──
// `codex exec` is the non-interactive form. Prompt goes via stdin to avoid
// arg-length limits. We pass --skip-git-repo-check because the workflow
// engine's cwd is not the user's repo (codex otherwise refuses to run in
// "untrusted" directories) and --sandbox read-only to be extra safe.
async function callCodexCLI(prompt, system, { timeoutMs = 180000 } = {}) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  return runCLI(
    resolve("codex"),
    ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"],
    fullPrompt,
    timeoutMs,
  );
}

// ── Gemini CLI (Google AI Pro / Code Assist subscription) ──
// `-p` requires a string value (Gemini CLI v0.43+); stdin is appended to it,
// so we pass an empty prompt value and stream the real prompt via stdin.
async function callGeminiCLI(prompt, system, { timeoutMs = 180000 } = {}) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  return runCLI(resolve("gemini"), ["-p", ""], fullPrompt, timeoutMs);
}

// ── Output post-processing ──
// CLIs sometimes wrap output in markdown fences or include a leading
// "thinking" line. Pull the meaningful body out.
function cleanCLIOutput(raw) {
  let s = stripAnsi(raw).trim();
  // Strip ```json … ``` or ``` … ``` fences
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
  if (fenced) s = fenced[1].trim();
  return s;
}

module.exports = {
  detectCLIs,
  callClaudeCLI,
  callCodexCLI,
  callGeminiCLI,
  cleanCLIOutput,
};
