// storage/sqlite.js — SQLite-backed storage, drop-in replacement for storage/index.js
const Database = require("better-sqlite3");
const path = require("path");
const os   = require("os");
const fs   = require("fs");

// Store DB in a local home-dir path so it survives system restarts without
// depending on Google Drive being mounted before the server starts.
const DB_DIR  = path.join(os.homedir(), ".workflow-engine");
const DB_PATH = path.join(DB_DIR, "workflow_engine.db");
const LEGACY_CREDENTIALS_FILE = path.join(__dirname, "credentials.json");
fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id          TEXT PRIMARY KEY,
    workflow_id TEXT,
    data        TEXT NOT NULL,
    created_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS logs_wf_idx ON logs (workflow_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS credentials (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL DEFAULT '{}'
  );
  INSERT OR IGNORE INTO credentials (id, data) VALUES (1, '{}');
`);

function readCredentialsRow() {
  const row = db.prepare("SELECT data FROM credentials WHERE id = 1").get();
  return row ? JSON.parse(row.data) : {};
}

function migrateMissingLegacyCredentials() {
  if (!fs.existsSync(LEGACY_CREDENTIALS_FILE)) return;

  const current = readCredentialsRow();
  const legacy = JSON.parse(fs.readFileSync(LEGACY_CREDENTIALS_FILE, "utf8"));
  const merged = { ...current };
  let changed = false;

  for (const [key, value] of Object.entries(legacy)) {
    if (!merged[key] && value && String(value).trim()) {
      merged[key] = String(value).trim();
      changed = true;
    }
  }

  if (changed) {
    db.prepare("INSERT OR REPLACE INTO credentials (id, data) VALUES (1, ?)").run(JSON.stringify(merged));
  }
}

migrateMissingLegacyCredentials();

// ─── Workflows ────────────────────────────────────────────────────────────────
function listWorkflows() {
  return db.prepare("SELECT data FROM workflows ORDER BY updated_at DESC").all()
    .map(r => JSON.parse(r.data));
}

function getWorkflow(id) {
  const row = db.prepare("SELECT data FROM workflows WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

function saveWorkflow(workflow) {
  const now = new Date().toISOString();
  workflow.updatedAt = now;
  db.prepare(`
    INSERT INTO workflows (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(workflow.id, JSON.stringify(workflow), workflow.createdAt || now, now);
  return workflow;
}

function deleteWorkflow(id) {
  db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return true;
}

// ─── Execution Logs ───────────────────────────────────────────────────────────
function saveLog(log) {
  const id = `${log.workflowId}_${Date.now()}`;
  db.prepare("INSERT OR IGNORE INTO logs (id, workflow_id, data, created_at) VALUES (?, ?, ?, ?)")
    .run(id, log.workflowId, JSON.stringify(log), log.startedAt || new Date().toISOString());
}

function getLogs(workflowId, limit = 20) {
  const rows = workflowId
    ? db.prepare("SELECT data FROM logs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?").all(workflowId, limit)
    : db.prepare("SELECT data FROM logs ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map(r => JSON.parse(r.data));
}

// ─── Credentials ──────────────────────────────────────────────────────────────
function getCredentials() {
  return readCredentialsRow();
}

function saveCredentials(creds) {
  const existing = getCredentials();
  const merged = { ...existing };
  for (const [k, v] of Object.entries(creds)) {
    if (v && String(v).trim()) merged[k] = String(v).trim();
  }
  db.prepare("INSERT OR REPLACE INTO credentials (id, data) VALUES (1, ?)").run(JSON.stringify(merged));
  return { saved: true };
}

module.exports = {
  listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow,
  saveLog, getLogs, getCredentials, saveCredentials,
};
