// storage/index.js
// Simple file-based storage — each workflow is a JSON file
// Production upgrade path: swap this for SQLite or PostgreSQL

const fs   = require("fs").promises;
const path = require("path");

const WORKFLOWS_DIR   = path.join(__dirname, "workflows");
const LOGS_DIR        = path.join(__dirname, "logs");
const CREDENTIALS_FILE = path.join(__dirname, "credentials.json");

async function ensureDirs() {
  await fs.mkdir(WORKFLOWS_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR,      { recursive: true });
}

// ─── Workflows ────────────────────────────────────────────────────────────────
async function listWorkflows() {
  await ensureDirs();
  const files = await fs.readdir(WORKFLOWS_DIR);
  const workflows = [];
  for (const file of files.filter(f => f.endsWith(".json"))) {
    try {
      const raw = await fs.readFile(path.join(WORKFLOWS_DIR, file), "utf8");
      workflows.push(JSON.parse(raw));
    } catch { /* skip corrupt files */ }
  }
  return workflows;
}

async function getWorkflow(id) {
  const filePath = path.join(WORKFLOWS_DIR, `${id}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveWorkflow(workflow) {
  await ensureDirs();
  workflow.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(WORKFLOWS_DIR, `${workflow.id}.json`), JSON.stringify(workflow, null, 2));
  return workflow;
}

async function deleteWorkflow(id) {
  try {
    await fs.unlink(path.join(WORKFLOWS_DIR, `${id}.json`));
    return true;
  } catch { return false; }
}

// ─── Execution Logs ───────────────────────────────────────────────────────────
async function saveLog(log) {
  await ensureDirs();
  const fileName = `${log.workflowId}_${Date.now()}.json`;
  await fs.writeFile(path.join(LOGS_DIR, fileName), JSON.stringify(log, null, 2));
}

async function getLogs(workflowId, limit = 20) {
  await ensureDirs();
  const files = (await fs.readdir(LOGS_DIR))
    .filter(f => f.endsWith(".json") && (!workflowId || f.startsWith(workflowId)))
    .sort()
    .reverse()
    .slice(0, limit);
  const logs = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(LOGS_DIR, file), "utf8");
      logs.push(JSON.parse(raw));
    } catch { /* skip */ }
  }
  return logs;
}

// ─── Credentials (stored locally, never sent to client) ───────────────────────
async function getCredentials() {
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf8");
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveCredentials(creds) {
  // Merge with existing — never overwrite keys with empty strings
  const existing = await getCredentials();
  const merged   = { ...existing };
  for (const [k, v] of Object.entries(creds)) {
    if (v && v.trim()) merged[k] = v.trim();
  }
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(merged, null, 2));
  return { saved: true };
}

module.exports = { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, saveLog, getLogs, getCredentials, saveCredentials };
