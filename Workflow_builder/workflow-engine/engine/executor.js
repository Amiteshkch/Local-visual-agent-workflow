// engine/executor.js
// Runs a workflow: topological sort → execute each node in order → collect logs

const { executeNode } = require("./nodes");

// ─── Topological Sort (Kahn's algorithm) ──────────────────────────────────────
function topoSort(nodes, connections) {
  const inDegree = {};
  const adjList  = {};
  nodes.forEach(n => { inDegree[n.id] = 0; adjList[n.id] = []; });
  connections.forEach(c => {
    if (adjList[c.from]) adjList[c.from].push(c.to);
    if (inDegree[c.to] !== undefined) inDegree[c.to]++;
  });

  const queue  = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
  const sorted = [];
  while (queue.length) {
    const id   = queue.shift();
    const node = nodes.find(n => n.id === id);
    if (node) sorted.push(node);
    (adjList[id] || []).forEach(nextId => {
      inDegree[nextId]--;
      if (inDegree[nextId] === 0) queue.push(nextId);
    });
  }
  // Append any disconnected nodes
  nodes.forEach(n => { if (!sorted.find(s => s.id === n.id)) sorted.push(n); });
  return sorted;
}

// ─── Get parent node output ────────────────────────────────────────────────────
function getParentOutput(nodeId, connections, results) {
  const parentConn = connections.find(c => c.to === nodeId);
  if (!parentConn) return null;
  return results[parentConn.from]?.output || null;
}

// ─── Main executor ────────────────────────────────────────────────────────────
async function executeWorkflow(workflow, credentials = {}, webhookData = null) {
  const { nodes = [], connections = [], name = "Unnamed" } = workflow;
  const startTime = Date.now();

  const executionLog = {
    workflowId:  workflow.id,
    workflowName: name,
    startedAt:   new Date().toISOString(),
    finishedAt:  null,
    duration:    null,
    status:      "running",
    steps:       [],
  };

  const results = {}; // nodeId → { success, output, error }
  const vars = {};    // shared variable store for set-variable / {{vars.x}}

  const sortedNodes = topoSort(nodes, connections);
  console.log(`[Executor] Running "${name}" — order: ${sortedNodes.map(n => n.type).join(" → ")}`);

  for (const node of sortedNodes) {
    const stepStart     = Date.now();
    const previousOutput = getParentOutput(node.id, connections, results);
    const maxRetries    = typeof node.config?.retries    === "number" ? node.config.retries    : 0;
    const retryDelay    = typeof node.config?.retryDelay === "number" ? node.config.retryDelay : 1000;

    console.log(`[Executor]  ⟳ Node ${node.type} (${node.id})`);

    let result;
    let attempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      result = await executeNode(node, { previousOutput, credentials, webhookData, workflowId: workflow.id, vars });
      if (result.success) break;
      if (attempt < maxRetries) {
        console.log(`[Executor]  ↺ Retry ${attempt + 1}/${maxRetries} for ${node.type} in ${retryDelay}ms…`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
    results[node.id] = result;

    const step = {
      nodeId:   node.id,
      nodeType: node.type,
      label:    node.config?.label || node.type,
      status:   result.success ? "success" : "error",
      output:   result.output,
      error:    result.error,
      duration: Date.now() - stepStart,
      ...(maxRetries > 0 && { attempts }),
    };
    executionLog.steps.push(step);

    if (result.success) {
      console.log(`[Executor]  ✓ ${node.type} done in ${step.duration}ms${maxRetries > 0 ? ` (attempt ${attempts}/${maxRetries + 1})` : ""}`);
    } else {
      console.log(`[Executor]  ✗ ${node.type} failed after ${attempts} attempt(s): ${result.error}`);
    }
  }

  executionLog.finishedAt = new Date().toISOString();
  executionLog.duration   = Date.now() - startTime;
  executionLog.status     = executionLog.steps.every(s => s.status === "success") ? "success" : "partial";
  executionLog.results    = results;

  console.log(`[Executor] "${name}" finished in ${executionLog.duration}ms — status: ${executionLog.status}`);
  return executionLog;
}

module.exports = { executeWorkflow, topoSort };
