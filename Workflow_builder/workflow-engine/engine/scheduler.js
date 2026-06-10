// engine/scheduler.js
// Watches all saved workflows for "schedule" trigger nodes
// and runs them on their cron schedule — 24/7, no browser needed.
//
// Catch-up (anacron-style): cron ticks are silently skipped while the
// machine is asleep, so a sweep runs on startup and every few minutes.
// If a workflow's last due time passed without a successful run, it is
// re-run now — but only once the network is actually reachable, since
// the agent nodes are useless offline.

const cron     = require("node-cron");
const dns      = require("dns").promises;
const { CronExpressionParser } = require("cron-parser");
const { executeWorkflow } = require("./executor");

const SWEEP_INTERVAL_MS    = 5 * 60 * 1000; // catch-up sweep cadence
const STARTUP_SWEEP_DELAY  = 15 * 1000;     // let the server settle first
const MAX_ATTEMPTS_PER_DUE = 3;             // retries per missed slot before giving up

class Scheduler {
  constructor(storage) {
    this.storage  = storage;  // storage module for reading workflows + credentials
    this.jobs     = {};       // workflowId → cron job
    this.running  = new Set(); // workflowIds currently executing (no double-runs)
    this.sweepTimer = null;
    console.log("[Scheduler] Initialized");
  }

  // Start scheduler — scan all workflows and register their schedule nodes
  async start() {
    const workflows = await this.storage.listWorkflows();
    for (const wf of workflows) {
      this.register(wf);
    }
    console.log(`[Scheduler] Running — ${Object.keys(this.jobs).length} scheduled workflow(s) active`);

    setTimeout(() => this.catchUpSweep(), STARTUP_SWEEP_DELAY);
    this.sweepTimer = setInterval(() => this.catchUpSweep(), SWEEP_INTERVAL_MS);
  }

  // Register a workflow's schedule node as a cron job
  register(workflow) {
    const scheduleNode = (workflow.nodes || []).find(n => n.type === "schedule");
    if (!scheduleNode) return;

    const cronExpr = scheduleNode.config?.cron;
    if (!cronExpr) return;

    if (!cron.validate(cronExpr)) {
      console.warn(`[Scheduler] Invalid cron "${cronExpr}" for workflow "${workflow.name}" — skipping`);
      return;
    }

    // Remove existing job for this workflow if any
    this.unregister(workflow.id);

    const job = cron.schedule(cronExpr, () => this.fire(workflow.id, workflow, "cron"), {
      timezone: scheduleNode.config?.timezone || "Asia/Kolkata",
    });

    this.jobs[workflow.id] = job;
    console.log(`[Scheduler] Registered "${workflow.name}" — cron: ${cronExpr}`);
  }

  // Execute one scheduled run and record the outcome in scheduler state
  async fire(workflowId, fallbackWf, reason) {
    if (this.running.has(workflowId)) {
      console.log(`[Scheduler] "${fallbackWf?.name || workflowId}" already running — skipping ${reason} fire`);
      return;
    }

    // Re-read workflow fresh so pause/update changes are picked up at fire time
    // (Promise.resolve: the sqlite backend is synchronous, the file backend async)
    const freshWf = await Promise.resolve()
      .then(() => this.storage.getWorkflow(workflowId))
      .catch(() => null) || fallbackWf;
    if (!freshWf) return;

    if (freshWf.pauseUntil && new Date() < new Date(freshWf.pauseUntil)) {
      console.log(`[Scheduler] "${freshWf.name}" paused until ${freshWf.pauseUntil} — skipping`);
      return;
    }

    console.log(`[Scheduler] Firing "${freshWf.name}" (${reason})`);
    this.running.add(workflowId);
    try {
      await this.recordState(workflowId, s => { s.lastRunAt = new Date().toISOString(); });
      const credentials = await this.storage.getCredentials();
      const log = await executeWorkflow(freshWf, credentials);
      await this.storage.saveLog(log);
      if (log.status === "success") {
        await this.recordState(workflowId, s => { s.lastSuccessAt = new Date().toISOString(); });
      }
    } catch (err) {
      console.error(`[Scheduler] Error running "${freshWf.name}":`, err.message);
    } finally {
      this.running.delete(workflowId);
    }
  }

  // ── Catch-up sweep ──────────────────────────────────────────────────────────
  // For each scheduled workflow: find the most recent due time. If there has
  // been no successful run since then, run it now (up to MAX_ATTEMPTS_PER_DUE
  // attempts per slot, and only while online).
  async catchUpSweep() {
    try {
      await this.runCatchUpSweep();
    } catch (err) {
      console.error("[Scheduler] Catch-up sweep failed:", err.message);
    }
  }

  async runCatchUpSweep() {
    const workflows = await this.storage.listWorkflows();
    const due = [];
    const state = await this.storage.getSchedulerState();

    for (const wf of workflows) {
      const scheduleNode = (wf.nodes || []).find(n => n.type === "schedule");
      const cronExpr = scheduleNode?.config?.cron;
      if (!cronExpr || !cron.validate(cronExpr)) continue;
      if (wf.pauseUntil && new Date() < new Date(wf.pauseUntil)) continue;
      if (this.running.has(wf.id)) continue;

      let lastDue;
      try {
        const it = CronExpressionParser.parse(cronExpr, {
          tz: scheduleNode.config?.timezone || "Asia/Kolkata",
        });
        lastDue = it.prev().toDate();
      } catch { continue; }

      const s = state[wf.id] || {};
      const lastSuccess = s.lastSuccessAt ? new Date(s.lastSuccessAt) : null;
      if (lastSuccess && lastSuccess >= lastDue) continue; // this slot already succeeded

      // Track attempts per due-slot so a persistently failing workflow
      // doesn't retry forever
      const slotKey = lastDue.toISOString();
      const attempts = s.dueSlot === slotKey ? (s.attempts || 0) : 0;
      if (attempts >= MAX_ATTEMPTS_PER_DUE) continue;

      due.push({ wf, slotKey, attempts });
    }

    if (due.length === 0) return;

    if (!(await this.isOnline())) {
      console.log(`[Scheduler] Catch-up: ${due.length} run(s) due but network is down — will retry next sweep`);
      return;
    }

    for (const { wf, slotKey, attempts } of due) {
      console.log(`[Scheduler] Catch-up: "${wf.name}" missed/failed its ${slotKey} run (attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_DUE})`);
      await this.recordState(wf.id, s => {
        s.dueSlot  = slotKey;
        s.attempts = attempts + 1;
      });
      // Sequential on purpose — the agent nodes are heavy (local LLM CLIs)
      await this.fire(wf.id, wf, "catch-up");
    }
  }

  // DNS resolution is what actually fails when the laptop wakes without
  // network, so test exactly that
  async isOnline() {
    try {
      await dns.lookup("generativelanguage.googleapis.com");
      return true;
    } catch {
      try {
        await dns.lookup("google.com");
        return true;
      } catch { return false; }
    }
  }

  async recordState(workflowId, mutate) {
    try {
      const state = await this.storage.getSchedulerState();
      state[workflowId] = state[workflowId] || {};
      mutate(state[workflowId]);
      await this.storage.saveSchedulerState(state);
    } catch (err) {
      console.error("[Scheduler] Failed to persist scheduler state:", err.message);
    }
  }

  // Remove a scheduled job (call when workflow is deleted or updated)
  unregister(workflowId) {
    if (this.jobs[workflowId]) {
      this.jobs[workflowId].stop();
      delete this.jobs[workflowId];
    }
  }

  // Refresh a workflow's schedule (call after save/update)
  async refresh(workflow) {
    this.unregister(workflow.id);
    this.register(workflow);
  }

  status() {
    return Object.keys(this.jobs).map(id => ({ workflowId: id, active: true }));
  }
}

module.exports = Scheduler;
