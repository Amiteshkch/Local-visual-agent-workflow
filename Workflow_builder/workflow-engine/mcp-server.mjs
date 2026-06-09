// mcp-server.mjs — Model Context Protocol server for Local Agent Studio.
// Lets Claude Code / Cursor / any MCP client search nodes and create, validate,
// run, and manage workflows. Reuses the engine + the same workflow store as the
// HTTP backend, so workflows created here also show up in the studio/dashboard.
//
// Run:   node mcp-server.mjs        (stdio transport)
// Wire:  claude mcp add local-agent-studio -- node /abs/path/to/mcp-server.mjs

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { executeWorkflow } = require("./engine/executor.js");
const { studioToEngineWorkflow } = require("./engine/nodes/index.js");
const { NODE_CATALOG, VALID_IDS, SERVER_CAPABLE } = require("./engine/catalog.js");
let storage; try { storage = require("./storage/sqlite"); } catch { storage = require("./storage/index.js"); }

// ── helpers ────────────────────────────────────────────────────────────────
function specToStudioWorkflow(spec = {}) {
  const id = spec.id || `wf-mcp-${Date.now()}`;
  const nodes = (spec.nodes || []).map((n, i) => ({
    id: `tool-${n.toolId}-${i}`,
    type: n.toolId === "sticky-note" ? "stickyNote" : "workflowNode",
    position: { x: 360 + i * 250, y: 470 + (i % 2) * 80 },
    data: { customToolId: n.toolId, label: n.label || n.toolId, custom: true, config: n.config || {} },
  }));
  const edges = (spec.edges || [])
    .filter(([a, b]) => nodes[a] && nodes[b] && a !== b)
    .map(([a, b], i) => ({ id: `manual-${nodes[a].id}-${nodes[b].id}-${i}`, source: nodes[a].id, target: nodes[b].id, type: "smoothstep" }));
  return { id, folderName: spec.name || "MCP workflow", customToolNodes: nodes, manualEdges: edges, files: [], pythonNodeCode: {} };
}

function validate(wf = {}) {
  const nodes = wf.customToolNodes || [];
  const ids = nodes.map(n => n.data?.customToolId).filter(Boolean);
  const unknown = [...new Set(ids.filter(id => !VALID_IDS.has(id)))];
  const browserOnly = [...new Set(ids.filter(id => VALID_IDS.has(id) && !SERVER_CAPABLE.has(id)))];
  return {
    ok: unknown.length === 0,
    nodeCount: nodes.length,
    edgeCount: (wf.manualEdges || []).length,
    unknownTypes: unknown,
    browserOnlyServerSide: browserOnly,
    note: browserOnly.length ? "Browser-only nodes are skipped when run server-side; run them in the studio for full output." : undefined,
  };
}

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// ── tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
  { name: "search_nodes", description: "Search the node catalog by keyword (name/category/description). Returns ids you can use in create_workflow.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional keyword filter" } } } },
  { name: "list_workflows", description: "List saved workflows (id + name).", inputSchema: { type: "object", properties: {} } },
  { name: "get_workflow", description: "Get a saved workflow by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_workflow", description: "Create + save a workflow from a node spec. nodes: [{toolId,label?,config?}]; edges: [[fromIndex,toIndex]] (0-based into nodes).",
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      nodes: { type: "array", items: { type: "object", properties: { toolId: { type: "string" }, label: { type: "string" }, config: { type: "object" } }, required: ["toolId"] } },
      edges: { type: "array", items: { type: "array", items: { type: "number" } } },
    }, required: ["name", "nodes"] } },
  { name: "validate_workflow", description: "Validate a saved workflow (by id) or an inline node spec; reports unknown/browser-only nodes.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, nodes: { type: "array" }, edges: { type: "array" } } } },
  { name: "run_workflow", description: "Run a saved workflow (by id) or an inline spec server-side; returns the execution log. Browser-only nodes are skipped.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, nodes: { type: "array" }, edges: { type: "array" } } } },
  { name: "delete_workflow", description: "Delete a saved workflow by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

async function resolveWorkflow(args) {
  if (args?.id && !args.nodes) { const wf = await storage.getWorkflow(args.id); if (!wf) throw new Error(`No workflow with id "${args.id}"`); return wf; }
  return specToStudioWorkflow(args);
}

async function handleCall(name, args = {}) {
  switch (name) {
    case "search_nodes": {
      const q = (args.query || "").toLowerCase();
      const hits = q ? NODE_CATALOG.filter(n => [n.id, n.label, n.category, n.description].some(v => v.toLowerCase().includes(q))) : NODE_CATALOG;
      return json({ count: hits.length, nodes: hits });
    }
    case "list_workflows": return json({ workflows: (await storage.listWorkflows()).map(w => ({ id: w.id, name: w.folderName || w.name })) });
    case "get_workflow": return json(await storage.getWorkflow(args.id) || { error: "not found" });
    case "create_workflow": {
      const wf = specToStudioWorkflow(args);
      const v = validate(wf);
      if (!v.ok) return json({ error: "Invalid node types", ...v });
      await storage.saveWorkflow(wf);
      return json({ created: true, id: wf.id, name: wf.folderName, validation: v });
    }
    case "validate_workflow": return json(validate(await resolveWorkflow(args)));
    case "run_workflow": {
      const wf = await resolveWorkflow(args);
      let creds = {}; try { creds = (await storage.getCredentials()) || {}; } catch {}
      const log = await executeWorkflow(studioToEngineWorkflow(wf), creds);
      return json({ status: log.status, durationMs: log.duration, steps: log.steps.map(s => ({ node: s.nodeType, status: s.status, error: s.error, output: s.output })) });
    }
    case "delete_workflow": await storage.deleteWorkflow(args.id); return json({ deleted: true, id: args.id });
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = new Server({ name: "local-agent-studio", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return await handleCall(req.params.name, req.params.arguments || {}); }
  catch (err) { return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] }; }
});

await server.connect(new StdioServerTransport());
console.error("[MCP] local-agent-studio server ready on stdio");
