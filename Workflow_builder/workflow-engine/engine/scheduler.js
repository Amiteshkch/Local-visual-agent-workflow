// engine/scheduler.js
// Watches all saved workflows for "schedule" trigger nodes
// and runs them on their cron schedule — 24/7, no browser needed

const cron     = require("node-cron");
const { executeWorkflow } = require("./executor");

class Scheduler {
  constructor(storage) {
    this.storage  = storage;  // storage module for reading workflows + credentials
    this.jobs     = {};       // workflowId → cron job
    console.log("[Scheduler] Initialized");
  }

  // Start scheduler — scan all workflows and register their schedule nodes
  async start() {
    const workflows = await this.storage.listWorkflows();
    for (const wf of workflows) {
      this.register(wf);
    }
    console.log(`[Scheduler] Running — ${Object.keys(this.jobs).length} scheduled workflow(s) active`);
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

    const job = cron.schedule(cronExpr, async () => {
      // Re-read workflow fresh so pause/update changes are picked up at fire time
      const freshWf = await this.storage.getWorkflow(workflow.id).catch(() => workflow);
      if (freshWf?.pauseUntil) {
        const pauseDate = new Date(freshWf.pauseUntil);
        if (new Date() < pauseDate) {
          console.log(`[Scheduler] "${workflow.name}" paused until ${freshWf.pauseUntil} — skipping`);
          return;
        }
      }
      console.log(`[Scheduler] Firing "${freshWf?.name || workflow.name}" (cron: ${cronExpr})`);
      try {
        const credentials = await this.storage.getCredentials();
        const log = await executeWorkflow(freshWf || workflow, credentials);
        await this.storage.saveLog(log);
      } catch (err) {
        console.error(`[Scheduler] Error running "${workflow.name}":`, err.message);
      }
    }, {
      timezone: scheduleNode.config?.timezone || "Asia/Kolkata",
    });

    this.jobs[workflow.id] = job;
    console.log(`[Scheduler] Registered "${workflow.name}" — cron: ${cronExpr}`);
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
