import { useState, useRef, useCallback, useEffect } from "react";

const NODE_DEFS = {
  // Triggers
  manual:    { label: "Manual Trigger",  icon: "▶", color: "#f59e0b", category: "trigger", inputs: 0, outputs: 1 },
  webhook:   { label: "Webhook",         icon: "⚡", color: "#f59e0b", category: "trigger", inputs: 0, outputs: 1 },
  schedule:  { label: "Schedule",        icon: "◷", color: "#f59e0b", category: "trigger", inputs: 0, outputs: 1 },
  rss:       { label: "RSS Feed",        icon: "◎", color: "#f97316", category: "trigger", inputs: 0, outputs: 1 },
  // Actions — communication
  gmail:     { label: "Gmail",           icon: "✉", color: "#4285f4", category: "action",  inputs: 1, outputs: 1 },
  slack:     { label: "Slack",           icon: "◈", color: "#a855f7", category: "action",  inputs: 1, outputs: 1 },
  discord:   { label: "Discord",         icon: "⬟", color: "#5865f2", category: "action",  inputs: 1, outputs: 1 },
  telegram:  { label: "Telegram",        icon: "✈", color: "#2196f3", category: "action",  inputs: 1, outputs: 1 },
  // Actions — data
  notion:    { label: "Notion",          icon: "◻", color: "#e5e5e5", category: "action",  inputs: 1, outputs: 1 },
  airtable:  { label: "Airtable",        icon: "⊠", color: "#f2b24e", category: "action",  inputs: 1, outputs: 1 },
  sheets:    { label: "Google Sheets",   icon: "⊞", color: "#34a853", category: "action",  inputs: 1, outputs: 1 },
  github:    { label: "GitHub",          icon: "⊛", color: "#e2e8f0", category: "action",  inputs: 1, outputs: 1 },
  // Actions — web
  http:      { label: "HTTP Request",    icon: "⟳", color: "#10b981", category: "action",  inputs: 1, outputs: 1 },
  scrape:    { label: "Web Scraper",     icon: "⌖", color: "#06b6d4", category: "action",  inputs: 1, outputs: 1 },
  // AI
  claude:    { label: "Claude Agent",    icon: "◉", color: "#8b5cf6", category: "ai",      inputs: 1, outputs: 1 },
  transform: { label: "Transform (JS)",  icon: "⚙", color: "#6366f1", category: "ai",      inputs: 1, outputs: 1 },
  python:    { label: "Python Script",   icon: "⟩", color: "#3b82f6", category: "ai",      inputs: 1, outputs: 1 },
  // Flow
  ifelse:    { label: "If / Else",       icon: "◇", color: "#10b981", category: "flow",    inputs: 1, outputs: 2 },
  merge:     { label: "Merge",           icon: "⊕", color: "#10b981", category: "flow",    inputs: 2, outputs: 1 },
  delay:     { label: "Delay",           icon: "⏸", color: "#94a3b8", category: "flow",    inputs: 1, outputs: 1 },
  filter:    { label: "Filter Array",    icon: "▽", color: "#10b981", category: "flow",    inputs: 1, outputs: 1 },
  set:       { label: "Set Variable",    icon: "≔", color: "#64748b", category: "flow",    inputs: 1, outputs: 1 },
};

const PALETTE = [
  { category: "Triggers",      types: ["manual", "webhook", "schedule", "rss"] },
  { category: "Messaging",     types: ["gmail", "slack", "discord", "telegram"] },
  { category: "Data / Apps",   types: ["notion", "airtable", "sheets", "github"] },
  { category: "Web",           types: ["http", "scrape"] },
  { category: "AI",            types: ["claude", "transform", "python"] },
  { category: "Flow Control",  types: ["ifelse", "merge", "delay", "filter", "set"] },
];

const NODE_CONFIG_FIELDS = {
  gmail:     [
    { key: "operation", label: "Operation",  type: "select",   options: ["Send Email", "Get Emails", "Search Emails"] },
    { key: "to",        label: "To",         type: "text",     placeholder: "recipient@email.com" },
    { key: "subject",   label: "Subject",    type: "text",     placeholder: "Email subject" },
    { key: "body",      label: "Body",       type: "textarea", placeholder: "Email body..." },
  ],
  slack:     [
    { key: "operation", label: "Operation",  type: "select",   options: ["Send Message", "Get Messages"] },
    { key: "channel",   label: "Channel",    type: "text",     placeholder: "#general" },
    { key: "message",   label: "Message",    type: "textarea", placeholder: "Your message..." },
  ],
  notion:    [
    { key: "operation", label: "Operation",  type: "select",   options: ["Create Page", "Get Page", "Update Page"] },
    { key: "database",  label: "Database ID",type: "text",     placeholder: "Database ID" },
    { key: "title",     label: "Title",      type: "text",     placeholder: "Page title" },
  ],
  claude:    [
    { key: "provider",    label: "AI Provider",    type: "select",   options: ["anthropic", "openai", "gemini", "ollama", "openai-compatible"] },
    { key: "model",       label: "Model",          type: "text",     placeholder: "claude-sonnet-4-20250514 / gpt-4o / gemini-2.0-flash / llama3" },
    { key: "prompt",      label: "System Prompt",  type: "textarea", placeholder: "You are a helpful assistant..." },
    { key: "userMessage", label: "User Message",   type: "textarea", placeholder: "What should the AI do? e.g. Summarize {{previousOutput.text}}" },
    { key: "max_tokens",  label: "Max Tokens",     type: "text",     placeholder: "1000" },
    { key: "ollamaUrl",   label: "Ollama URL",     type: "text",     placeholder: "http://localhost:11434 (only for Ollama)" },
  ],
  http:      [
    { key: "method",    label: "Method",     type: "select",   options: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
    { key: "url",       label: "URL",        type: "text",     placeholder: "https://api.example.com/endpoint" },
    { key: "body",      label: "Body (JSON)",type: "textarea", placeholder: '{"key": "value"}' },
  ],
  webhook:   [
    { key: "path",      label: "Path",       type: "text",     placeholder: "/webhook/my-trigger" },
    { key: "method",    label: "Method",     type: "select",   options: ["GET", "POST", "PUT"] },
  ],
  schedule:  [
    { key: "cron",      label: "Cron Expression", type: "text", placeholder: "0 9 * * 1-5" },
    { key: "timezone",  label: "Timezone",   type: "text",     placeholder: "Asia/Kolkata" },
  ],
  transform: [
    { key: "code",      label: "JavaScript", type: "textarea", placeholder: "return { ...items[0], transformed: true };" },
  ],
  ifelse:    [
    { key: "condition", label: "Condition",  type: "text",     placeholder: '{{data.status}} === "active"' },
  ],
  discord:  [
    { key: "webhookUrl", label: "Webhook URL",  type: "text",     placeholder: "https://discord.com/api/webhooks/ID/TOKEN" },
    { key: "message",    label: "Message",      type: "textarea", placeholder: "{{previousOutput.text}}" },
    { key: "username",   label: "Bot Name",     type: "text",     placeholder: "Workflow Bot" },
  ],
  telegram: [
    { key: "botToken",   label: "Bot Token",    type: "text",     placeholder: "1234567890:ABCdef..." },
    { key: "chatId",     label: "Chat ID",      type: "text",     placeholder: "-100123456789 or @channel" },
    { key: "message",    label: "Message",      type: "textarea", placeholder: "{{previousOutput.text}}" },
  ],
  github:   [
    { key: "operation",  label: "Operation",    type: "select",   options: ["Create Issue", "List Issues", "Get Repo Info"] },
    { key: "repo",       label: "Owner/Repo",   type: "text",     placeholder: "owner/repo-name" },
    { key: "token",      label: "Token",        type: "text",     placeholder: "github_pat_..." },
    { key: "title",      label: "Issue Title",  type: "text",     placeholder: "{{previousOutput.text}}" },
    { key: "body",       label: "Issue Body",   type: "textarea", placeholder: "Details..." },
  ],
  airtable: [
    { key: "operation",  label: "Operation",    type: "select",   options: ["Create Record", "List Records"] },
    { key: "baseId",     label: "Base ID",      type: "text",     placeholder: "appXXXXXXXXXXXXXX" },
    { key: "tableId",    label: "Table Name",   type: "text",     placeholder: "Table 1" },
    { key: "apiKey",     label: "API Key",      type: "text",     placeholder: "pat..." },
    { key: "fields",     label: "Fields (JSON)",type: "textarea", placeholder: '{"Name": "{{previousOutput.text}}"}' },
  ],
  sheets:   [
    { key: "operation",     label: "Operation",       type: "select",   options: ["Append Row", "Read Sheet"] },
    { key: "spreadsheetId", label: "Spreadsheet ID",  type: "text",     placeholder: "1BxiMVs0XRA5n..." },
    { key: "range",         label: "Range",           type: "text",     placeholder: "Sheet1!A:E" },
    { key: "token",         label: "OAuth Token",     type: "text",     placeholder: "ya29...." },
    { key: "values",        label: "Row Values (JSON array)", type: "textarea", placeholder: '["{{previousOutput.text}}", "value2"]' },
  ],
  rss:      [
    { key: "url",        label: "Feed URL",     type: "text",     placeholder: "https://news.ycombinator.com/rss" },
    { key: "limit",      label: "Max Items",    type: "text",     placeholder: "5" },
  ],
  scrape:   [
    { key: "url",        label: "URL to Scrape",  type: "text",   placeholder: "https://example.com" },
    { key: "selector",   label: "CSS Selector",   type: "text",   placeholder: "h1, p, article (optional)" },
    { key: "mode",       label: "Output Mode",    type: "select", options: ["Full Text", "Links", "Title + Meta"] },
  ],
  python:   [
    { key: "code",       label: "Python Code",    type: "textarea", placeholder: "# previous_output and files are injected\nprint(previous_output)" },
    { key: "backendUrl", label: "Backend URL",    type: "text",     placeholder: "http://localhost:3001" },
  ],
  delay:    [
    { key: "seconds",    label: "Delay (seconds)", type: "text",  placeholder: "2" },
  ],
  filter:   [
    { key: "field",      label: "Array Field",    type: "text",   placeholder: "items  (or blank to use previousOutput directly)" },
    { key: "condition",  label: "Keep item if",   type: "text",   placeholder: 'item.status === "active"' },
  ],
  set:      [
    { key: "key",        label: "Variable Name",  type: "text",     placeholder: "result" },
    { key: "value",      label: "Value",          type: "textarea", placeholder: "{{previousOutput.text}}" },
  ],
  manual: [], merge: [],
};

const SIMULATED_OUTPUT = {
  manual:    "Workflow triggered manually",
  webhook:   "Webhook received: POST /webhook/trigger → 200 OK",
  schedule:  "Scheduled trigger fired at 09:00 IST",
  rss:       "✓ 5 RSS items fetched",
  gmail:     "✓ Email sent successfully to recipient",
  slack:     "✓ Message posted to #general",
  discord:   "✓ Message sent to Discord",
  telegram:  "✓ Message sent to Telegram chat",
  notion:    "✓ Page created in database",
  airtable:  "✓ Airtable record created",
  sheets:    "✓ Row appended to Sheet1",
  github:    "✓ GitHub issue #42 created",
  http:      "✓ HTTP 200 OK — { success: true }",
  scrape:    "✓ Scraped 1200 chars from example.com",
  claude:    '✓ AI: "I have processed your request..."',
  transform: "✓ Transformed: { status: 'active', count: 42 }",
  python:    "✓ Script ran — stdout: Hello from Python!",
  ifelse:    "✓ Condition evaluated → true branch taken",
  merge:     "✓ Merged 2 input streams → unified output",
  delay:     "✓ Waited 2 seconds",
  filter:    "✓ Filter: 3 of 10 items passed",
  set:       "✓ Set variable 'result'",
};

let _id = 100;
const uid = () => String(++_id);

// ── Template interpolation — resolves {{previousOutput.field}} in config strings ──
function interpolate(text, prev) {
  if (typeof text !== "string" || !prev) return text;
  return text.replace(/\{\{([\w.[\]]+)\}\}/g, (match, path) => {
    const clean = path.replace(/^(previousOutput|data)\.?/, "");
    const keys  = clean.split(/[.[\]]+/).filter(Boolean);
    let val = prev;
    for (const k of keys) { if (val == null) return match; val = val[k]; }
    return val != null ? String(val) : match;
  });
}
function interpolateNodeConfig(config, prev) {
  if (!prev || !config) return config;
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, interpolate(v, prev)]));
}

const NODE_W = 168;
const NODE_H = 64;

export default function WorkflowBuilder() {
  const [nodes, setNodes] = useState([
    { id: "1", type: "manual",  x: 80,  y: 180, config: {} },
    { id: "2", type: "claude",  x: 340, y: 180, config: { provider: "ollama", prompt: "You are a local workflow agent. Be concise and practical.", model: "qwen3.5:9b", userMessage: "Suggest the next useful automation step for this workflow." } },
    { id: "3", type: "transform", x: 600, y: 180, config: { code: "return { summary: previousOutput.reply || previousOutput, ready: true };" } },
  ]);
  const [connections, setConnections] = useState([
    { id: "c1", from: "1", fromPort: 0, to: "2", toPort: 0 },
    { id: "c2", from: "2", fromPort: 0, to: "3", toPort: 0 },
  ]);
  const [selected,   setSelected]   = useState(null);
  const [dragging,   setDragging]   = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [logs,       setLogs]       = useState([]);
  const [running,    setRunning]    = useState(false);
  const [showLogs,   setShowLogs]   = useState(false);
  const [wfName,       setWfName]       = useState("My First Workflow");
  const [apiKey,       setApiKey]       = useState("");
  const [settingsTokens, setSettingsTokens] = useState({ openaiApiKey:"", geminiApiKey:"", customBaseUrl:"", customApiKey:"" });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab,  setSettingsTab]  = useState("claude");
  const [slackToken,   setSlackToken]   = useState("");
  const [gmailToken,    setGmailToken]    = useState("");
  const [showExtractor, setShowExtractor] = useState(false);
  const [extInput,      setExtInput]      = useState("");
  const [extInputType,  setExtInputType]  = useState("url"); // url | code | describe
  const [extAnalyzing,  setExtAnalyzing]  = useState(false);
  const [extResults,    setExtResults]    = useState(null);  // { projectName, summary, detectedWorkflows[] }
  const [extSelected,   setExtSelected]   = useState({});   // { workflowIdx_nodeIdx: true }
  const [nodeOutputs,   setNodeOutputs]   = useState({});
  const [useBackend,    setUseBackend]    = useState(true);
  const [backendUrl,    setBackendUrl]    = useState("http://localhost:3001");
  const [backendOk,     setBackendOk]    = useState(null); // null|true|false
  const canvasRef    = useRef(null);
  const fileInputRef = useRef(null);

  // ── Topological sort ──────────────────────────────────────────────────────
  const topoSort = useCallback((nodeList, connList) => {
    const inDegree = {};
    const adjList  = {};
    nodeList.forEach(n => { inDegree[n.id] = 0; adjList[n.id] = []; });
    connList.forEach(c => {
      if (adjList[c.from]) adjList[c.from].push(c.to);
      if (inDegree[c.to]  !== undefined) inDegree[c.to]++;
    });
    const queue  = nodeList.filter(n => inDegree[n.id] === 0).map(n => n.id);
    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      const node = nodeList.find(n => n.id === id);
      if (node) sorted.push(node);
      (adjList[id] || []).forEach(nextId => {
        inDegree[nextId]--;
        if (inDegree[nextId] === 0) queue.push(nextId);
      });
    }
    // Append any remaining nodes (handles disconnected nodes)
    nodeList.forEach(n => { if (!sorted.find(s => s.id === n.id)) sorted.push(n); });
    return sorted;
  }, []);

  // ── Save workflow to JSON file ────────────────────────────────────────────
  const saveWorkflow = useCallback(() => {
    const data = { name: wfName, version: "1.0", savedAt: new Date().toISOString(), nodes, connections };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${wfName.replace(/\s+/g, "_").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [wfName, nodes, connections]);

  // ── Load workflow from JSON file ──────────────────────────────────────────
  const loadWorkflow = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.nodes || !data.connections) throw new Error("Invalid workflow file");
        setNodes(data.nodes);
        setConnections(data.connections);
        if (data.name) setWfName(data.name);
        setSelected(null);
        setLogs([{ id: uid(), status: "done", time: new Date().toLocaleTimeString(), label: "System", message: `✓ Loaded "${data.name}" — ${data.nodes.length} nodes, ${data.connections.length} connections` }]);
        setShowLogs(true);
      } catch (err) {
        alert("Failed to load workflow: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = ""; // reset so same file can be re-loaded
  }, []);

  // ── Save workflow to backend server ──────────────────────────────────────────
  const saveToBackend = useCallback(async () => {
    const wf = { name: wfName, id: `wf-${Date.now()}`, nodes, connections };
    try {
      const res  = await fetch(`${backendUrl}/api/workflows`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wf),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLogs(prev => [...prev, { id: uid(), status: "done", time: new Date().toLocaleTimeString(), label: "Backend", message: `✓ Saved "${data.name}" to backend (id: ${data.id})` }]);
    } catch (err) {
      setLogs(prev => [...prev, { id: uid(), status: "error", time: new Date().toLocaleTimeString(), label: "Backend", message: `✗ Backend unreachable at ${backendUrl}: ${err.message}` }]);
    }
    setShowLogs(true);
  }, [wfName, nodes, connections, backendUrl]);

  const pingBackend = useCallback(async (url) => {
    const base = url || backendUrl;
    try {
      const res = await fetch(`${base}/api/health`);
      setBackendOk(res.ok);
    } catch { setBackendOk(false); }
  }, [backendUrl]);

  useEffect(() => {
    pingBackend(backendUrl);
  }, [backendUrl, pingBackend]);

  // ── Real Slack API ────────────────────────────────────────────────────────
  const callSlackAPI = useCallback(async (node) => {
    const { operation = "Send Message", channel = "#general", message = "Hello from your workflow!" } = node.config;
    if (!slackToken) throw new Error("No Slack Bot Token — add it in Settings");
    if (operation === "Send Message") {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "Authorization": `Bearer ${slackToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text: message }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Slack API error");
      return `Message sent to ${channel} (ts: ${data.ts})`;
    } else {
      const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=5`, {
        headers: { "Authorization": `Bearer ${slackToken}` },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Slack API error");
      const preview = (data.messages || []).slice(0, 2).map(m => m.text?.slice(0, 60)).join(" | ");
      return `Got ${data.messages?.length || 0} messages: "${preview}…"`;
    }
  }, [slackToken]);

  // ── Real Gmail API ────────────────────────────────────────────────────────
  const callGmailAPI = useCallback(async (node) => {
    const { operation = "Get Emails", to = "", subject = "", body = "" } = node.config;
    if (!gmailToken) throw new Error("No Gmail token — add it in Settings");
    if (operation === "Get Emails" || operation === "Search Emails") {
      const q = operation === "Search Emails" ? "is:unread" : "in:inbox";
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`, {
        headers: { "Authorization": `Bearer ${gmailToken}` },
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Gmail error ${res.status}`); }
      const data = await res.json();
      return `Found ${data.resultSizeEstimate || 0} emails (showing up to 5 message IDs)`;
    } else {
      if (!to) throw new Error("No recipient — set 'To' in node config");
      const raw = btoa(`To: ${to}\r\nSubject: ${subject || "(no subject)"}\r\nContent-Type: text/plain\r\n\r\n${body}`)
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${gmailToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Gmail error ${res.status}`); }
      return `✓ Email sent to ${to} — subject: "${subject}"`;
    }
  }, [gmailToken]);

  // ── Real HTTP Request ─────────────────────────────────────────────────────
  const callHTTPAPI = useCallback(async (node) => {
    const { method = "GET", url = "", body: reqBody = "" } = node.config;
    if (!url) throw new Error("No URL — configure the HTTP node first");
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (reqBody && method !== "GET") { try { opts.body = JSON.stringify(JSON.parse(reqBody)); } catch { opts.body = reqBody; } }
    const res  = await fetch(url, opts);
    const text = await res.text();
    let preview;
    try { preview = JSON.stringify(JSON.parse(text)).slice(0, 120); } catch { preview = text.slice(0, 120); }
    return `HTTP ${res.status} ${res.statusText} → ${preview}${preview.length >= 120 ? "…" : ""}`;
  }, []);

  // ── Discord Webhook ───────────────────────────────────────────────────────
  const callDiscordAPI = useCallback(async (node) => {
    const { webhookUrl, message = "", username = "Workflow Bot" } = node.config;
    if (!webhookUrl) throw new Error("No Discord Webhook URL — add it in node config");
    const res = await fetch(webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, username }),
    });
    if (!res.ok) throw new Error(`Discord error ${res.status}`);
    return `Message sent to Discord`;
  }, []);

  // ── Telegram Bot API ──────────────────────────────────────────────────────
  const callTelegramAPI = useCallback(async (node) => {
    const { botToken, chatId, message = "" } = node.config;
    if (!botToken || !chatId) throw new Error("No Telegram bot token or chat ID — add in node config");
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "Telegram API error");
    return `Message sent (id: ${data.result?.message_id})`;
  }, []);

  // ── GitHub API ────────────────────────────────────────────────────────────
  const callGitHubAPI = useCallback(async (node) => {
    const { operation = "List Issues", repo, token, title = "", body: issueBody = "" } = node.config;
    if (!repo) throw new Error("No GitHub repo — set Owner/Repo in node config");
    const headers = { "Content-Type": "application/json", "Accept": "application/vnd.github+json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) };
    if (operation === "Create Issue") {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: "POST", headers, body: JSON.stringify({ title, body: issueBody }) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || `GitHub ${res.status}`); }
      const data = await res.json();
      return `Issue #${data.number} created: "${data.title}"`;
    } else if (operation === "List Issues") {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=5`, { headers });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || `GitHub ${res.status}`); }
      const data = await res.json();
      return { issues: data.map(i => ({ number: i.number, title: i.title, url: i.html_url })), count: data.length };
    } else {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      if (!res.ok) { const e = await res.json(); throw new Error(e.message || `GitHub ${res.status}`); }
      const data = await res.json();
      return { name: data.name, description: data.description, stars: data.stargazers_count, language: data.language, openIssues: data.open_issues_count };
    }
  }, []);

  // ── Airtable API ──────────────────────────────────────────────────────────
  const callAirtableAPI = useCallback(async (node) => {
    const { operation = "List Records", baseId, tableId, apiKey: airtableKey, fields: fieldsJson = "" } = node.config;
    if (!airtableKey || !baseId || !tableId) throw new Error("Missing Airtable credentials — set Base ID, Table Name, API Key");
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}`;
    const headers = { "Authorization": `Bearer ${airtableKey}`, "Content-Type": "application/json" };
    if (operation === "Create Record") {
      let fields = {};
      try { fields = JSON.parse(fieldsJson); } catch { fields = { Name: fieldsJson }; }
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ fields }) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Airtable ${res.status}`); }
      const data = await res.json();
      return { id: data.id, fields: data.fields };
    } else {
      const res = await fetch(`${url}?maxRecords=10`, { headers });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Airtable ${res.status}`); }
      const data = await res.json();
      return { records: (data.records || []).map(r => ({ id: r.id, ...r.fields })), count: data.records?.length || 0 };
    }
  }, []);

  // ── Google Sheets API ─────────────────────────────────────────────────────
  const callSheetsAPI = useCallback(async (node) => {
    const { operation = "Read Sheet", spreadsheetId, range = "Sheet1!A1:Z100", token, values: valuesJson = "" } = node.config;
    if (!token || !spreadsheetId) throw new Error("Missing Google Sheets OAuth token or spreadsheet ID");
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
    if (operation === "Append Row") {
      let vals = [];
      try { vals = JSON.parse(valuesJson); if (!Array.isArray(vals)) vals = [vals]; } catch { vals = [valuesJson]; }
      const res = await fetch(`${base}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`, {
        method: "POST", headers, body: JSON.stringify({ values: [vals] }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Sheets ${res.status}`); }
      const data = await res.json();
      return { updatedRange: data.updates?.updatedRange, updatedRows: data.updates?.updatedRows };
    } else {
      const res = await fetch(`${base}/values/${encodeURIComponent(range)}`, { headers });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Sheets ${res.status}`); }
      const data = await res.json();
      return { values: data.values || [], count: data.values?.length || 0, range: data.range };
    }
  }, []);

  // ── RSS Feed (via rss2json.com) ───────────────────────────────────────────
  const callRSSAPI = useCallback(async (node) => {
    const { url, limit = "5" } = node.config;
    if (!url) throw new Error("No RSS feed URL — add it in node config");
    const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=${parseInt(limit) || 5}`);
    if (!res.ok) throw new Error(`RSS fetch error ${res.status}`);
    const data = await res.json();
    if (data.status !== "ok") throw new Error(data.message || "RSS parse error");
    const items = (data.items || []).map(i => ({ title: i.title, link: i.link, pubDate: i.pubDate, summary: (i.description || "").replace(/<[^>]+>/g, "").slice(0, 200) }));
    return { feed: data.feed?.title, items, count: items.length, text: items.map(i => i.title).join("\n") };
  }, []);

  // ── Web Scraper (via allorigins CORS proxy) ───────────────────────────────
  const callScrapeAPI = useCallback(async (node) => {
    const { url, selector = "", mode = "Full Text" } = node.config;
    if (!url) throw new Error("No URL — add it in node config");
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`Scrape proxy error ${res.status} — check the URL`);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, nav, footer, header").forEach(el => el.remove());
    if (mode === "Title + Meta") {
      const title = doc.querySelector("title")?.textContent || "";
      const desc  = doc.querySelector('meta[name="description"]')?.getAttribute("content") || doc.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
      return { title, description: desc, url, text: `${title}\n${desc}` };
    }
    if (mode === "Links") {
      const links = Array.from(doc.querySelectorAll("a[href]")).slice(0, 30).map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.href })).filter(l => l.text && l.href.startsWith("http"));
      return { links, count: links.length, url };
    }
    const target = selector ? Array.from(doc.querySelectorAll(selector)) : [doc.body];
    let text = target.map(el => el?.textContent || "").join("\n").replace(/\s+/g, " ").trim();
    return { text: text.slice(0, 4000), charCount: text.length, url };
  }, []);

  // ── Python Script (via workflow-engine backend) ───────────────────────────
  const callPythonAPI = useCallback(async (node) => {
    const { code = "print('Hello from Python!')", backendUrl: nodeBackend = "" } = node.config;
    const base = (nodeBackend || backendUrl).replace(/\/$/, "");
    const res = await fetch(`${base}/api/python/run`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, files: [], previousOutput: null, timeout: 30 }),
    });
    if (!res.ok) throw new Error(`Backend ${res.status} — start: cd workflow-engine && node server.js`);
    const data = await res.json();
    const stdout = data.output?.stdout || "";
    const stderr = data.output?.stderr || "";
    if (!data.success && !stdout) throw new Error(data.error || stderr || "Script failed");
    return { stdout, stderr, exitCode: data.output?.exitCode, text: stdout };
  }, [backendUrl]);

  // ── Workflow Extractor ────────────────────────────────────────────────────
  const analyzeWorkflow = useCallback(async () => {
    if (!extInput.trim()) return alert("Please enter a URL, code, or description first.");
    if (!apiKey.trim())   return alert("A Claude API key is required for extraction. Add it in Settings → Claude.");
    setExtAnalyzing(true);
    setExtResults(null);
    setExtSelected({});

    const inputLabel = extInputType === "url"      ? `Website/project URL: ${extInput}`
                     : extInputType === "code"     ? `Source code:\n\`\`\`\n${extInput}\n\`\`\``
                     :                               `Project description: ${extInput}`;

    const SYSTEM = `You are a workflow analysis expert. Given a project (URL, code, or description), extract all automation workflows, integrations, and processes.

Return ONLY valid JSON — no markdown, no explanation, no backticks. Schema:
{
  "projectName": "string",
  "summary": "1-2 sentence description of the project",
  "detectedWorkflows": [
    {
      "name": "workflow name",
      "description": "what this workflow does",
      "nodes": [
        {
          "type": "one of: manual|webhook|schedule|gmail|slack|notion|http|claude|transform|ifelse|merge",
          "label": "descriptive label for this node",
          "config": { ...relevant config fields for this node type }
        }
      ],
      "connections": [{ "from": 0, "to": 1 }]
    }
  ]
}

Map every feature, integration, trigger, or automation to the closest node type. Be thorough — extract 2-5 workflows minimum. Config fields should match real usage (e.g. for gmail: operation, to, subject; for slack: channel, message; for webhook: path, method).`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: SYSTEM,
          messages: [{ role: "user", content: `Analyze this and extract all workflows:\n\n${inputLabel}` }],
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `API error ${res.status}`); }
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setExtResults(parsed);
      // Pre-select all nodes
      const sel = {};
      (parsed.detectedWorkflows || []).forEach((wf, wi) => {
        (wf.nodes || []).forEach((_, ni) => { sel[`${wi}_${ni}`] = true; });
      });
      setExtSelected(sel);
    } catch (err) {
      alert("Extraction failed: " + err.message);
    } finally {
      setExtAnalyzing(false);
    }
  }, [extInput, extInputType, apiKey]);

  const addExtractedToCanvas = useCallback(() => {
    if (!extResults) return;
    let offsetX = 80;
    const newNodes = [];
    const newConns = [];

    (extResults.detectedWorkflows || []).forEach((wf, wi) => {
      const wfNodes = [];
      (wf.nodes || []).forEach((n, ni) => {
        if (!extSelected[`${wi}_${ni}`]) return;
        const id = uid();
        const x  = offsetX;
        const y  = 80 + wi * 180;
        newNodes.push({ id, type: n.type || "http", x, y, config: n.config || {} });
        wfNodes.push({ localIdx: ni, id });
        offsetX += 220;
      });
      // Wire connections between selected nodes
      (wf.connections || []).forEach(c => {
        const fromNode = wfNodes.find(n => n.localIdx === c.from);
        const toNode   = wfNodes.find(n => n.localIdx === c.to);
        if (fromNode && toNode) {
          newConns.push({ id: uid(), from: fromNode.id, fromPort: 0, to: toNode.id, toPort: 0 });
        }
      });
      offsetX += 60; // gap between workflows
    });

    setNodes(prev => [...prev, ...newNodes]);
    setConnections(prev => [...prev, ...newConns]);
    setShowExtractor(false);
    setExtResults(null);
    setExtInput("");
    setLogs(prev => [...prev, { id: uid(), status: "done", time: new Date().toLocaleTimeString(), label: "Extractor", message: `✓ Added ${newNodes.length} nodes from "${extResults.projectName}"` }]);
    setShowLogs(true);
  }, [extResults, extSelected]);

  const getPortPos = useCallback((nodeId, portIdx, isOutput) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return { x: 0, y: 0 };
    const def = NODE_DEFS[node.type];
    const total = isOutput ? def.outputs : def.inputs;
    return {
      x: isOutput ? node.x + NODE_W : node.x,
      y: node.y + NODE_H / 2 + (portIdx - (total - 1) / 2) * 22,
    };
  }, [nodes]);

  const onCanvasMouseMove = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    if (dragging) {
      setNodes(prev => prev.map(n =>
        n.id === dragging.nodeId
          ? { ...n, x: Math.max(0, e.clientX - rect.left - dragging.ox), y: Math.max(0, e.clientY - rect.top - dragging.oy) }
          : n
      ));
    }
    if (connecting) {
      setConnecting(prev => ({ ...prev, mx: e.clientX - rect.left, my: e.clientY - rect.top }));
    }
  }, [dragging, connecting]);

  const onCanvasMouseUp = useCallback(() => {
    setDragging(null);
    setConnecting(null);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("nodeType");
    if (!type) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setNodes(prev => [...prev, { id: uid(), type, x: e.clientX - rect.left - NODE_W / 2, y: e.clientY - rect.top - NODE_H / 2, config: {} }]);
  }, []);

  const startConnect = useCallback((e, nodeId, portIdx) => {
    e.stopPropagation();
    const pos = getPortPos(nodeId, portIdx, true);
    setConnecting({ fromId: nodeId, fromPort: portIdx, mx: pos.x, my: pos.y });
  }, [getPortPos]);

  const endConnect = useCallback((e, nodeId, portIdx) => {
    e.stopPropagation();
    if (!connecting || connecting.fromId === nodeId) return;
    setConnections(prev => [...prev, { id: uid(), from: connecting.fromId, fromPort: connecting.fromPort, to: nodeId, toPort: portIdx }]);
    setConnecting(null);
  }, [connecting]);

  const deleteNode = useCallback((nodeId) => {
    setNodes(prev => prev.filter(n => n.id !== nodeId));
    setConnections(prev => prev.filter(c => c.from !== nodeId && c.to !== nodeId));
    if (selected === nodeId) setSelected(null);
  }, [selected]);

  const deleteConnection = useCallback((connId) => {
    setConnections(prev => prev.filter(c => c.id !== connId));
  }, []);

  const updateConfig = useCallback((nodeId, key, val) => {
    setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, config: { ...n.config, [key]: val } } : n));
  }, []);

  const callClaudeAPI = useCallback(async (node) => {
    const {
      provider    = "anthropic",
      prompt      = "You are a helpful assistant.",
      userMessage = "Hello! What can you do?",
      model       = "",
      max_tokens  = "1000",
      ollamaUrl   = "http://localhost:11434",
    } = node.config;
    const maxTok = parseInt(max_tokens) || 1000;

    if (provider === "anthropic") {
      if (!apiKey) throw new Error("No Anthropic API key — add it in Settings → Claude");
      const mdl = model || "claude-sonnet-4-20250514";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: mdl, max_tokens: maxTok, system: prompt, messages: [{ role: "user", content: userMessage }] }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `Anthropic error ${res.status}`); }
      const data = await res.json();
      return data.content?.[0]?.text || "(no response)";
    }

    if (provider === "openai") {
      const key = settingsTokens.openaiApiKey;
      if (!key) throw new Error("No OpenAI API key — add it in Settings → OpenAI");
      const mdl = model || "gpt-4o";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({ model: mdl, max_tokens: maxTok, messages: [{ role: "system", content: prompt }, { role: "user", content: userMessage }] }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `OpenAI error ${res.status}`); }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "(no response)";
    }

    if (provider === "gemini") {
      const key = settingsTokens.geminiApiKey;
      if (!key) throw new Error("No Gemini API key — add it in Settings → Gemini");
      const mdl = model || "gemini-2.0-flash";
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt}\n\n${userMessage}` }] }], generationConfig: { maxOutputTokens: maxTok } }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `Gemini error ${res.status}`); }
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "(no response)";
    }

    if (provider === "ollama") {
      const base = (ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
      const mdl  = model || "llama3";
      const res  = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: mdl, stream: false, messages: [{ role: "system", content: prompt }, { role: "user", content: userMessage }] }),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status} — is Ollama running at ${base}?`);
      const data = await res.json();
      return data.message?.content || "(no response)";
    }

    if (provider === "openai-compatible") {
      const base = (settingsTokens.customBaseUrl || "").replace(/\/$/, "");
      const key  = settingsTokens.customApiKey || "";
      if (!base) throw new Error("No custom base URL — add it in Settings → Custom");
      const mdl  = model || "default";
      const res  = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "Authorization": `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: mdl, max_tokens: maxTok, messages: [{ role: "system", content: prompt }, { role: "user", content: userMessage }] }),
      });
      if (!res.ok) { const e = await res.json().catch(()=>{}); throw new Error(e?.error?.message || `API error ${res.status}`); }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "(no response)";
    }

    throw new Error(`Unknown provider: ${provider}`);
  }, [apiKey, settingsTokens]);

  const runWorkflow = useCallback(async () => {
    // ── Backend mode ─────────────────────────────────────────────────────────
    if (useBackend) {
      setRunning(true); setShowLogs(true); setNodeOutputs({});
      setLogs([{ id: uid(), status: "info", time: new Date().toLocaleTimeString(), label: "System", message: `⟳ Sending "${wfName}" to backend at ${backendUrl}…` }]);
      try {
        const res  = await fetch(`${backendUrl}/api/execute`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: wfName, nodes, connections }),
        });
        const log  = await res.json();
        if (!res.ok) throw new Error(log.error || `HTTP ${res.status}`);
        const steps = (log.steps || []).map(step => ({
          id: uid(), nodeId: step.nodeId, status: step.status,
          time: new Date().toLocaleTimeString(),
          label: step.label || step.nodeType,
          message: step.status === "success"
            ? `✓ ${JSON.stringify(step.output).slice(0, 200)}`
            : `✗ ${step.error}`,
        }));
        setLogs(prev => [...prev, ...steps, {
          id: uid(), status: "done", time: new Date().toLocaleTimeString(),
          label: "Backend", message: `Completed in ${log.duration}ms — status: ${log.status}`,
        }]);
        if (log.results) {
          const out = {};
          for (const [nid, r] of Object.entries(log.results)) { if (r.success) out[nid] = r.output; }
          setNodeOutputs(out);
        }
      } catch (err) {
        setLogs(prev => [...prev, { id: uid(), status: "error", time: new Date().toLocaleTimeString(), label: "Backend", message: `✗ Backend error: ${err.message}` }]);
      }
      setRunning(false);
      return;
    }

    // ── Browser-side validation ───────────────────────────────────────────────
    const aiNodes = nodes.filter(n => n.type === "claude");
    for (const n of aiNodes) {
      const provider = n.config?.provider || "anthropic";
      if (provider === "anthropic" && !apiKey.trim()) {
        setShowSettings(true); setSettingsTab("claude");
        setLogs([{ id: uid(), status: "error", time: new Date().toLocaleTimeString(), label: "System", message: "⚠ Add your Anthropic API key in Settings → Claude." }]);
        setShowLogs(true); return;
      }
      if (provider === "openai" && !settingsTokens.openaiApiKey) {
        setShowSettings(true); setSettingsTab("openai");
        setLogs([{ id: uid(), status: "error", time: new Date().toLocaleTimeString(), label: "System", message: "⚠ Add your OpenAI API key in Settings → OpenAI." }]);
        setShowLogs(true); return;
      }
      if (provider === "gemini" && !settingsTokens.geminiApiKey) {
        setShowSettings(true); setSettingsTab("gemini");
        setLogs([{ id: uid(), status: "error", time: new Date().toLocaleTimeString(), label: "System", message: "⚠ Add your Gemini API key in Settings → Gemini." }]);
        setShowLogs(true); return;
      }
    }

    setRunning(true);
    setShowLogs(true);
    setNodeOutputs({});
    const results     = {};   // nodeId → output object (for data passing)
    const sortedNodes = topoSort(nodes, connections);
    setLogs([{ id: uid(), status: "info", time: new Date().toLocaleTimeString(), label: "System", message: `Starting: "${wfName}" — ${sortedNodes.map(n => NODE_DEFS[n.type].label).join(" → ")}` }]);

    for (const node of sortedNodes) {
      await new Promise(r => setTimeout(r, 400));
      const runId = uid();
      setLogs(prev => [...prev, { id: runId, nodeId: node.id, status: "running", time: new Date().toLocaleTimeString(), label: NODE_DEFS[node.type].label, message: "Executing…" }]);

      // Find parent node output for template interpolation
      const parentConn    = connections.find(c => c.to === node.id);
      const previousOutput = parentConn ? (results[parentConn.from] ?? null) : null;
      // Apply {{previousOutput.field}} substitution in config values
      const resolvedNode  = { ...node, config: interpolateNodeConfig(node.config, previousOutput) };

      try {
        let message, outputData;
        if (resolvedNode.type === "claude") {
          const provider = resolvedNode.config?.provider || "anthropic";
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: `Calling ${provider} API…` } : l));
          const text = await callClaudeAPI(resolvedNode);
          outputData = { text, reply: text, provider };
          message = `✓ AI (${provider}): "${text.slice(0, 180)}${text.length > 180 ? "…" : ""}"`;
        } else if (resolvedNode.type === "slack") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Calling Slack API…" } : l));
          const reply = await callSlackAPI(resolvedNode);
          outputData = { sent: true, message: reply }; message = `✓ ${reply}`;
        } else if (resolvedNode.type === "gmail") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Calling Gmail API…" } : l));
          const reply = await callGmailAPI(resolvedNode);
          outputData = { sent: true, message: reply }; message = `✓ ${reply}`;
        } else if (resolvedNode.type === "http") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: `Fetching ${resolvedNode.config.url || "URL"}…` } : l));
          const reply = await callHTTPAPI(resolvedNode);
          outputData = { response: reply, text: reply }; message = `✓ ${reply}`;
        } else if (resolvedNode.type === "discord") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Sending to Discord…" } : l));
          const reply = await callDiscordAPI(resolvedNode);
          outputData = { sent: true, message: reply }; message = `✓ ${reply}`;
        } else if (resolvedNode.type === "telegram") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Sending to Telegram…" } : l));
          const reply = await callTelegramAPI(resolvedNode);
          outputData = { sent: true, message: reply }; message = `✓ ${reply}`;
        } else if (resolvedNode.type === "github") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Calling GitHub API…" } : l));
          const reply = await callGitHubAPI(resolvedNode);
          outputData = typeof reply === "string" ? { text: reply, sent: true } : reply;
          message = `✓ ${typeof reply === "string" ? reply : JSON.stringify(reply).slice(0, 120)}`;
        } else if (resolvedNode.type === "airtable") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Calling Airtable API…" } : l));
          outputData = await callAirtableAPI(resolvedNode);
          message = `✓ Airtable: ${JSON.stringify(outputData).slice(0, 120)}`;
        } else if (resolvedNode.type === "sheets") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Calling Google Sheets…" } : l));
          outputData = await callSheetsAPI(resolvedNode);
          message = `✓ Sheets: ${JSON.stringify(outputData).slice(0, 120)}`;
        } else if (resolvedNode.type === "rss") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: `Fetching RSS: ${resolvedNode.config.url || "URL"}…` } : l));
          outputData = await callRSSAPI(resolvedNode);
          message = `✓ RSS "${outputData.feed}": ${outputData.count} items`;
        } else if (resolvedNode.type === "scrape") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: `Scraping ${resolvedNode.config.url || "URL"}…` } : l));
          outputData = await callScrapeAPI(resolvedNode);
          message = `✓ Scraped ${outputData.charCount || outputData.count || 0} chars from ${resolvedNode.config.url?.slice(0, 40)}`;
        } else if (resolvedNode.type === "python") {
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: "Running Python script via backend…" } : l));
          outputData = await callPythonAPI(resolvedNode);
          const preview = (outputData.stdout || "").trim().split("\n")[0]?.slice(0, 100) || "(no output)";
          message = `✓ Python (exit ${outputData.exitCode}): "${preview}"`;
        } else if (resolvedNode.type === "delay") {
          const secs = Math.min(parseFloat(resolvedNode.config.seconds) || 1, 30);
          setLogs(prev => prev.map(l => l.id === runId ? { ...l, message: `Waiting ${secs}s…` } : l));
          await new Promise(r => setTimeout(r, secs * 1000));
          outputData = { delayed: true, seconds: secs, ...previousOutput };
          message = `✓ Waited ${secs} second${secs !== 1 ? "s" : ""}`;
        } else if (resolvedNode.type === "filter") {
          const { field, condition = "true" } = resolvedNode.config;
          const arr = field ? (previousOutput?.[field] || []) : (Array.isArray(previousOutput) ? previousOutput : []);
          if (!arr.length) { outputData = { items: [], count: 0, total: 0 }; message = "✓ Filter: 0 items (empty input)"; }
          else {
            // eslint-disable-next-line no-new-func
            const fn = new Function("item", "index", "previousOutput", `"use strict"; return Boolean(${condition});`);
            const filtered = arr.filter((item, i) => { try { return fn(item, i, previousOutput); } catch { return false; } });
            outputData = { items: filtered, count: filtered.length, total: arr.length };
            message = `✓ Filter: ${filtered.length} of ${arr.length} items kept`;
          }
        } else if (resolvedNode.type === "set") {
          const { key = "result", value = "" } = resolvedNode.config;
          const resolved = interpolate(value, previousOutput);
          outputData = { ...(typeof previousOutput === "object" ? previousOutput : {}), [key]: resolved };
          message = `✓ Set "${key}" = "${String(resolved).slice(0, 60)}"`;
        } else {
          await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
          const sim = SIMULATED_OUTPUT[resolvedNode.type] || `✓ ${NODE_DEFS[resolvedNode.type]?.label || resolvedNode.type} executed`;
          outputData = { text: sim, triggered: true };
          message = sim;
        }
        results[node.id] = outputData;
        setNodeOutputs(prev => ({ ...prev, [node.id]: outputData }));
        setLogs(prev => prev.map(l => l.id === runId ? { ...l, status: "success", message } : l));
      } catch (err) {
        results[node.id] = { error: err.message };
        setLogs(prev => prev.map(l => l.id === runId ? { ...l, status: "error", message: `✗ Error: ${err.message}` } : l));
      }
    }

    setLogs(prev => [...prev, { id: uid(), status: "done", time: new Date().toLocaleTimeString(), label: "System", message: `Workflow completed — ${nodes.length} nodes executed` }]);
    setRunning(false);
  }, [nodes, connections, wfName, apiKey, settingsTokens, useBackend, backendUrl, callClaudeAPI, callSlackAPI, callGmailAPI, callHTTPAPI, callDiscordAPI, callTelegramAPI, callGitHubAPI, callAirtableAPI, callSheetsAPI, callRSSAPI, callScrapeAPI, callPythonAPI, topoSort]);

  const selectedNode = nodes.find(n => n.id === selected);
  const logCount = logs.filter(l => l.status === "success").length;

  const inputStyle = {
    width: "100%", padding: "7px 10px", background: "#111",
    border: "1px solid #222", borderRadius: "6px", color: "#e5e5e5",
    fontSize: "11px", fontFamily: "inherit", outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#070707", color: "#e5e5e5", fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace", overflow: "hidden" }}>

      {/* ── TOP BAR ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", height: "50px", background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", flexShrink: 0, gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ width: "26px", height: "26px", background: "#f59e0b", borderRadius: "6px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: "900", color: "#000", flexShrink: 0 }}>W</div>
          <input value={wfName} onChange={e => setWfName(e.target.value)}
            style={{ background: "transparent", border: "none", color: "#ddd", fontSize: "13px", fontFamily: "inherit", outline: "none", width: "200px" }} />
          <input ref={fileInputRef} type="file" accept=".json" onChange={loadWorkflow} style={{ display: "none" }} />
          <span style={{ color: "#333", fontSize: "11px" }}>● saved</span>
          <button onClick={saveWorkflow} title="Save workflow as JSON"
            style={{ padding: "4px 10px", background: "transparent", border: "1px solid #222", color: "#666", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#10b981"; e.currentTarget.style.color = "#10b981"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#222";    e.currentTarget.style.color = "#666"; }}>
            ↓ Save
          </button>
          <button onClick={() => fileInputRef.current?.click()} title="Load workflow from JSON"
            style={{ padding: "4px 10px", background: "transparent", border: "1px solid #222", color: "#666", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#3b82f6"; e.currentTarget.style.color = "#3b82f6"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#222";    e.currentTarget.style.color = "#666"; }}>
            ↑ Load
          </button>
          <button onClick={saveToBackend} title="Save workflow to local backend server"
            style={{ padding: "4px 10px", background: "transparent", border: "1px solid #222", color: "#666", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit", transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#f59e0b"; e.currentTarget.style.color = "#f59e0b"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#222";    e.currentTarget.style.color = "#666"; }}>
            ↑↗ Backend
          </button>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "11px", color: "#444" }}>{nodes.length} nodes · {connections.length} connections</span>
          <button onClick={() => setShowExtractor(true)} style={{ padding: "5px 12px", background: "transparent", border: "1px solid #10b98133", color: "#10b981", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit", transition: "all 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "#10b98111"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            ⊕ Extract
          </button>
          <button onClick={() => setShowSettings(v => !v)} style={{ padding: "5px 12px", background: showSettings ? "#1a1a1a" : "transparent", border: `1px solid ${showSettings ? "#f59e0b44" : "#222"}`, color: showSettings ? "#f59e0b" : "#777", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit" }}>
            ⚙ Settings
          </button>
          <button onClick={() => setShowLogs(v => !v)} style={{ padding: "5px 12px", background: "transparent", border: "1px solid #222", color: "#777", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit" }}>
            Logs {logCount > 0 ? `(${logCount})` : ""}
          </button>
          <button onClick={runWorkflow} disabled={running} style={{ padding: "5px 16px", background: running ? "#1a1a1a" : "#f59e0b", border: "none", color: running ? "#555" : "#000", borderRadius: "5px", cursor: running ? "not-allowed" : "pointer", fontSize: "11px", fontWeight: "700", fontFamily: "inherit", transition: "all 0.2s" }}>
            {running ? "⟳  Running…" : "▶  Execute"}
          </button>
        </div>
      </div>

      {/* ── SETTINGS BAR ── */}
      {showSettings && (
        <div style={{ background: "#0a0a0a", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: "2px", padding: "8px 18px 0", borderBottom: "1px solid #141414", flexWrap: "wrap" }}>
            {[["claude", "◉ Claude", "#8b5cf6"], ["openai", "⬡ OpenAI", "#10b981"], ["gemini", "✦ Gemini", "#4285f4"], ["ollama", "○ Ollama", "#f59e0b"], ["openai-compatible", "⚙ Custom", "#6366f1"], ["slack", "◈ Slack", "#a855f7"], ["gmail", "✉ Gmail", "#4285f4"], ["http", "⟳ HTTP", "#10b981"], ["backend", "⬡ Backend", "#f59e0b"]].map(([tab, label, color]) => (
              <button key={tab} onClick={() => setSettingsTab(tab)} style={{ padding: "5px 12px", background: settingsTab === tab ? "#141414" : "transparent", border: `1px solid ${settingsTab === tab ? color + "44" : "transparent"}`, borderBottom: "none", color: settingsTab === tab ? color : "#444", borderRadius: "5px 5px 0 0", cursor: "pointer", fontSize: "10px", fontFamily: "inherit", transition: "all 0.15s" }}>
                {label}
              </button>
            ))}
          </div>
          {/* Tab content */}
          <div style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
            {settingsTab === "claude" && <>
              <span style={{ fontSize: "10px", color: "#8b5cf6", flexShrink: 0 }}>API Key</span>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-api03-…"
                style={{ flex: 1, maxWidth: "360px", padding: "6px 10px", background: "#111", border: `1px solid ${apiKey ? "#8b5cf644" : "#222"}`, borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: "#555" }}>Model: claude-sonnet-4-20250514, claude-opus-4-20250514</span>
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#8b5cf6", textDecoration: "none" }}>Get key →</a>
            </>}
            {settingsTab === "openai" && <>
              <span style={{ fontSize: "10px", color: "#10b981", flexShrink: 0 }}>API Key</span>
              <input type="password" value={settingsTokens.openaiApiKey} onChange={e => setSettingsTokens(p => ({ ...p, openaiApiKey: e.target.value }))} placeholder="sk-proj-…"
                style={{ flex: 1, maxWidth: "360px", padding: "6px 10px", background: "#111", border: `1px solid ${settingsTokens.openaiApiKey ? "#10b98144" : "#222"}`, borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: "#555" }}>Model: gpt-4o, gpt-4o-mini, gpt-4-turbo, o1</span>
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#10b981", textDecoration: "none" }}>Get key →</a>
            </>}
            {settingsTab === "gemini" && <>
              <span style={{ fontSize: "10px", color: "#4285f4", flexShrink: 0 }}>API Key</span>
              <input type="password" value={settingsTokens.geminiApiKey} onChange={e => setSettingsTokens(p => ({ ...p, geminiApiKey: e.target.value }))} placeholder="AIza…"
                style={{ flex: 1, maxWidth: "360px", padding: "6px 10px", background: "#111", border: `1px solid ${settingsTokens.geminiApiKey ? "#4285f444" : "#222"}`, borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: "#555" }}>Model: gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash</span>
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#4285f4", textDecoration: "none" }}>Get key →</a>
            </>}
            {settingsTab === "ollama" && <>
              <span style={{ fontSize: "10px", color: "#f59e0b", flexShrink: 0 }}>Base URL</span>
              <input type="text" value={settingsTokens.ollamaUrl || "http://localhost:11434"} onChange={e => setSettingsTokens(p => ({ ...p, ollamaUrl: e.target.value }))} placeholder="http://localhost:11434"
                style={{ flex: 1, maxWidth: "280px", padding: "6px 10px", background: "#111", border: "1px solid #222", borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: "#555" }}>Models: llama3, mistral, phi3, gemma3, codellama, deepseek-r1 — set in node config</span>
              <a href="https://ollama.com" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#f59e0b", textDecoration: "none" }}>Install →</a>
            </>}
            {settingsTab === "openai-compatible" && <>
              <span style={{ fontSize: "10px", color: "#6366f1", flexShrink: 0 }}>Base URL</span>
              <input type="text" value={settingsTokens.customBaseUrl} onChange={e => setSettingsTokens(p => ({ ...p, customBaseUrl: e.target.value }))} placeholder="https://api.groq.com/openai"
                style={{ flex: 1, maxWidth: "280px", padding: "6px 10px", background: "#111", border: "1px solid #222", borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <input type="password" value={settingsTokens.customApiKey} onChange={e => setSettingsTokens(p => ({ ...p, customApiKey: e.target.value }))} placeholder="API key (if needed)"
                style={{ width: "180px", padding: "6px 10px", background: "#111", border: "1px solid #222", borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: "#555" }}>Works with: Groq, OpenRouter, Together AI, LM Studio, vLLM</span>
            </>}
            {settingsTab === "slack" && <>
              <span style={{ fontSize: "10px", color: "#a855f7", flexShrink: 0 }}>Bot Token</span>
              <input type="password" value={slackToken} onChange={e => setSlackToken(e.target.value)} placeholder="xoxb-…"
                style={{ flex: 1, maxWidth: "360px", padding: "6px 10px", background: "#111", border: `1px solid ${slackToken ? "#a855f744" : "#222"}`, borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: slackToken ? "#10b981" : "#444" }}>{slackToken ? "✓ Connected" : "Not set"}</span>
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#a855f7", textDecoration: "none" }}>Create app →</a>
            </>}
            {settingsTab === "gmail" && <>
              <span style={{ fontSize: "10px", color: "#4285f4", flexShrink: 0 }}>OAuth Token</span>
              <input type="password" value={gmailToken} onChange={e => setGmailToken(e.target.value)} placeholder="ya29.…"
                style={{ flex: 1, maxWidth: "360px", padding: "6px 10px", background: "#111", border: `1px solid ${gmailToken ? "#4285f444" : "#222"}`, borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <span style={{ fontSize: "10px", color: gmailToken ? "#10b981" : "#444" }}>{gmailToken ? "✓ Connected" : "Not set"}</span>
              <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noreferrer" style={{ fontSize: "10px", color: "#4285f4", textDecoration: "none" }}>OAuth Playground →</a>
              <span style={{ fontSize: "10px", color: "#333" }}>Scope: https://mail.google.com/</span>
            </>}
            {settingsTab === "http" && (
              <span style={{ fontSize: "10px", color: "#555", lineHeight: 1.6 }}>
                HTTP nodes use real <code style={{ color: "#10b981" }}>fetch()</code> — no token needed. Configure URL, method, and body in the node config panel.
              </span>
            )}
            {settingsTab === "backend" && <>
              <span style={{ fontSize: "10px", color: "#f59e0b", flexShrink: 0 }}>Server URL</span>
              <input type="text" value={backendUrl} onChange={e => setBackendUrl(e.target.value)} placeholder="http://localhost:3001"
                style={{ width: "220px", padding: "6px 10px", background: "#111", border: "1px solid #222", borderRadius: "5px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none" }} />
              <button onClick={() => pingBackend(backendUrl)} style={{ padding: "5px 10px", background: "transparent", border: "1px solid #f59e0b44", color: "#f59e0b", borderRadius: "5px", cursor: "pointer", fontSize: "10px", fontFamily: "inherit" }}>
                Ping
              </button>
              <span style={{ fontSize: "10px", color: backendOk === true ? "#10b981" : backendOk === false ? "#ef4444" : "#444" }}>
                {backendOk === true ? "✓ Online" : backendOk === false ? "✗ Offline" : "Not checked"}
              </span>
              <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                <input type="checkbox" checked={useBackend} onChange={e => setUseBackend(e.target.checked)} style={{ accentColor: "#f59e0b" }} />
                <span style={{ fontSize: "10px", color: useBackend ? "#f59e0b" : "#555" }}>
                  {useBackend ? "▶ Execute via backend" : "Execute in browser"}
                </span>
              </label>
              <span style={{ fontSize: "10px", color: "#333" }}>Backend runs credentials server-side — start with: <code style={{ color: "#f59e0b" }}>cd workflow-engine && node server.js</code></span>
            </>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── LEFT PALETTE ── */}
        <div style={{ width: "210px", background: "#0a0a0a", borderRight: "1px solid #161616", overflow: "auto", flexShrink: 0, padding: "10px 0" }}>
          <div style={{ padding: "0 14px 10px", color: "#444", fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase" }}>Node Library</div>
          {PALETTE.map(group => (
            <div key={group.category}>
              <div style={{ padding: "8px 14px 4px", color: "#555", fontSize: "9px", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: "700" }}>{group.category}</div>
              {group.types.map(type => {
                const def = NODE_DEFS[type];
                return (
                  <div key={type} draggable onDragStart={e => e.dataTransfer.setData("nodeType", type)}
                    style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 14px", cursor: "grab", transition: "background 0.1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#141414"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ width: "26px", height: "26px", borderRadius: "5px", background: `${def.color}18`, border: `1px solid ${def.color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: def.color, flexShrink: 0 }}>{def.icon}</div>
                    <span style={{ fontSize: "11px", color: "#aaa" }}>{def.label}</span>
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ padding: "20px 14px 6px", color: "#333", fontSize: "10px", lineHeight: 1.5 }}>
            ↑ Drag nodes onto the canvas to add them
          </div>
        </div>

        {/* ── CANVAS ── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <div ref={canvasRef}
            style={{ width: "100%", height: "100%", position: "relative", backgroundImage: "radial-gradient(circle, #1c1c1c 1px, transparent 1px)", backgroundSize: "22px 22px", cursor: dragging ? "grabbing" : "default" }}
            onMouseMove={onCanvasMouseMove} onMouseUp={onCanvasMouseUp}
            onDragOver={e => e.preventDefault()} onDrop={onDrop}
            onClick={() => setSelected(null)}>

            {/* SVG Connections */}
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}>
              <defs>
                <marker id="arr" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                  <polygon points="0 0, 7 2.5, 0 5" fill="#f59e0b55" />
                </marker>
              </defs>
              {connections.map(conn => {
                const A = getPortPos(conn.from, conn.fromPort, true);
                const B = getPortPos(conn.to,   conn.toPort,  false);
                const cx = (A.x + B.x) / 2;
                return (
                  <g key={conn.id} style={{ pointerEvents: "all" }} onClick={() => deleteConnection(conn.id)}>
                    <path d={`M${A.x},${A.y} C${cx},${A.y} ${cx},${B.y} ${B.x},${B.y}`}
                      fill="none" stroke="transparent" strokeWidth="12" style={{ cursor: "pointer" }} />
                    <path d={`M${A.x},${A.y} C${cx},${A.y} ${cx},${B.y} ${B.x},${B.y}`}
                      fill="none" stroke="#f59e0b44" strokeWidth="2" markerEnd="url(#arr)" />
                  </g>
                );
              })}
              {connecting && (() => {
                const A = getPortPos(connecting.fromId, connecting.fromPort, true);
                return <line x1={A.x} y1={A.y} x2={connecting.mx} y2={connecting.my} stroke="#f59e0b" strokeWidth="2" strokeDasharray="5,3" />;
              })()}
            </svg>

            {/* Nodes */}
            {nodes.map(node => {
              const def = NODE_DEFS[node.type];
              const isSel = selected === node.id;
              const log = logs.find(l => l.nodeId === node.id);
              const status = log?.status;

              return (
                <div key={node.id} style={{ position: "absolute", left: node.x, top: node.y, width: NODE_W, zIndex: isSel ? 20 : 5, userSelect: "none" }}
                  onClick={e => { e.stopPropagation(); setSelected(node.id); }}>

                  {/* Input ports */}
                  {Array.from({ length: def.inputs }).map((_, i) => (
                    <div key={i} onMouseUp={e => endConnect(e, node.id, i)}
                      style={{ position: "absolute", left: -6, top: NODE_H / 2 + (i - (def.inputs - 1) / 2) * 22 - 6, width: 12, height: 12, borderRadius: "50%", background: connecting ? "#f59e0b55" : "#1a1a1a", border: `2px solid ${connecting ? "#f59e0b" : "#333"}`, cursor: "crosshair", zIndex: 10, transition: "all 0.15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#f59e0b"; e.currentTarget.style.transform = "scale(1.3)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = connecting ? "#f59e0b55" : "#1a1a1a"; e.currentTarget.style.transform = "scale(1)"; }} />
                  ))}

                  {/* Node card */}
                  <div style={{ background: "#111", border: `1px solid ${isSel ? def.color : status === "success" ? "#10b98166" : status === "running" ? "#f59e0b66" : "#222"}`, borderRadius: "8px", overflow: "hidden", boxShadow: isSel ? `0 0 0 2px ${def.color}33, 0 4px 20px rgba(0,0,0,0.6)` : "0 2px 12px rgba(0,0,0,0.5)", transition: "border-color 0.2s, box-shadow 0.2s", cursor: "grab" }}
                    onMouseDown={e => {
                      e.stopPropagation();
                      const rect = canvasRef.current.getBoundingClientRect();
                      setDragging({ nodeId: node.id, ox: e.clientX - rect.left - node.x, oy: e.clientY - rect.top - node.y });
                    }}>
                    <div style={{ padding: "9px 10px", display: "flex", alignItems: "center", gap: "8px", borderBottom: "1px solid #181818" }}>
                      <div style={{ width: "24px", height: "24px", borderRadius: "5px", background: `${def.color}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", color: def.color, flexShrink: 0 }}>{def.icon}</div>
                      <span style={{ fontSize: "11px", color: "#ccc", fontWeight: "600", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{def.label}</span>
                      <button onClick={e => { e.stopPropagation(); deleteNode(node.id); }}
                        style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: "15px", lineHeight: 1, padding: "0", flexShrink: 0, transition: "color 0.15s" }}
                        onMouseEnter={e => e.currentTarget.style.color = "#ef4444"}
                        onMouseLeave={e => e.currentTarget.style.color = "#333"}>×</button>
                    </div>
                    <div style={{ padding: "5px 10px", minHeight: "22px", display: "flex", flexDirection: "column", justifyContent: "center", gap: "2px" }}>
                      {status === "running" && <span style={{ fontSize: "10px", color: "#f59e0b" }}>⟳ Running…</span>}
                      {status === "success" && (
                        <>
                          <span style={{ fontSize: "10px", color: "#10b981" }}>✓ Done</span>
                          {nodeOutputs[node.id] && (() => {
                            const out = nodeOutputs[node.id];
                            const preview = out.text || out.reply || out.message || (out.sent ? "Sent" : null) || JSON.stringify(out).slice(0, 40);
                            return <span style={{ fontSize: "9px", color: "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "148px" }}>{String(preview).slice(0, 50)}{String(preview).length > 50 ? "…" : ""}</span>;
                          })()}
                        </>
                      )}
                      {status === "error" && <span style={{ fontSize: "10px", color: "#ef4444" }}>✗ Error</span>}
                      {!status && <span style={{ fontSize: "10px", color: "#333" }}>{Object.keys(node.config).length > 0 ? "Configured ·" : "Click to configure"}</span>}
                    </div>
                  </div>

                  {/* Output ports */}
                  {Array.from({ length: def.outputs }).map((_, i) => (
                    <div key={i} onMouseDown={e => startConnect(e, node.id, i)}
                      style={{ position: "absolute", right: -6, top: NODE_H / 2 + (i - (def.outputs - 1) / 2) * 22 - 6, width: 12, height: 12, borderRadius: "50%", background: "#f59e0b33", border: "2px solid #f59e0b", cursor: "crosshair", zIndex: 10, transition: "all 0.15s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#f59e0b"; e.currentTarget.style.transform = "scale(1.4)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#f59e0b33"; e.currentTarget.style.transform = "scale(1)"; }} />
                  ))}
                </div>
              );
            })}

            {/* Empty state */}
            {nodes.length === 0 && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#2a2a2a", pointerEvents: "none", gap: "8px" }}>
                <div style={{ fontSize: "36px" }}>⬡</div>
                <div style={{ fontSize: "13px" }}>Drag nodes from the left panel to get started</div>
              </div>
            )}

            {/* Hint */}
            <div style={{ position: "absolute", bottom: showLogs ? 212 : 12, left: 12, fontSize: "10px", color: "#2a2a2a", pointerEvents: "none" }}>
              Drag node to move · Yellow dot → drag to connect · Click connection to delete
            </div>
          </div>

          {/* ── LOGS PANEL ── */}
          {showLogs && (
            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "200px", background: "#080808", borderTop: "1px solid #181818", overflow: "auto", padding: "10px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", alignItems: "center" }}>
                <span style={{ fontSize: "9px", color: "#444", textTransform: "uppercase", letterSpacing: "0.12em" }}>Execution Logs</span>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={() => setLogs([])} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "10px", fontFamily: "inherit" }}>Clear</button>
                  <button onClick={() => setShowLogs(false)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: 1 }}>×</button>
                </div>
              </div>
              {logs.length === 0 && <div style={{ color: "#2a2a2a", fontSize: "11px" }}>No executions yet — click Execute to run the workflow.</div>}
              {logs.map(log => (
                <div key={log.id} style={{ display: "flex", gap: "12px", padding: "3px 0", borderBottom: "1px solid #0f0f0f", fontSize: "10px", alignItems: "baseline" }}>
                  <span style={{ color: "#333", flexShrink: 0 }}>{log.time}</span>
                  <span style={{ color: log.status === "success" ? "#10b981" : log.status === "running" ? "#f59e0b" : log.status === "done" ? "#8b5cf6" : log.status === "error" ? "#ef4444" : "#555", flexShrink: 0, width: "50px" }}>
                    {log.status === "success" ? "✓ OK" : log.status === "running" ? "⟳ RUN" : log.status === "done" ? "★ END" : log.status === "error" ? "✗ ERR" : "· ···"}
                  </span>
                  <span style={{ color: "#555", flexShrink: 0, width: "110px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.label}</span>
                  <span style={{ color: "#999" }}>{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT CONFIG PANEL ── */}
        {selectedNode && (
          <div style={{ width: "255px", background: "#0a0a0a", borderLeft: "1px solid #161616", padding: "14px", overflow: "auto", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <span style={{ fontSize: "9px", color: "#555", textTransform: "uppercase", letterSpacing: "0.12em" }}>Configure Node</span>
              <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "16px", lineHeight: 1 }}>×</button>
            </div>

            {/* Node header card */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px", background: "#111", borderRadius: "7px", border: "1px solid #1a1a1a", marginBottom: "16px" }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "7px", background: `${NODE_DEFS[selectedNode.type].color}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px", color: NODE_DEFS[selectedNode.type].color, flexShrink: 0 }}>
                {NODE_DEFS[selectedNode.type].icon}
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "#e5e5e5", fontWeight: "600" }}>{NODE_DEFS[selectedNode.type].label}</div>
                <div style={{ fontSize: "9px", color: "#444" }}>id: {selectedNode.id}</div>
              </div>
            </div>

            {/* Fields */}
            {(NODE_CONFIG_FIELDS[selectedNode.type] || []).map(field => (
              <div key={field.key} style={{ marginBottom: "13px" }}>
                <label style={{ display: "block", fontSize: "9px", color: "#555", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.1em" }}>{field.label}</label>
                {field.type === "select" ? (
                  <select value={selectedNode.config[field.key] || ""} onChange={e => updateConfig(selectedNode.id, field.key, e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                    <option value="">Select…</option>
                    {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea value={selectedNode.config[field.key] || ""} onChange={e => updateConfig(selectedNode.id, field.key, e.target.value)}
                    placeholder={field.placeholder} rows={4}
                    style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
                ) : (
                  <input type="text" value={selectedNode.config[field.key] || ""} onChange={e => updateConfig(selectedNode.id, field.key, e.target.value)}
                    placeholder={field.placeholder} style={inputStyle} />
                )}
              </div>
            ))}

            {(NODE_CONFIG_FIELDS[selectedNode.type] || []).length === 0 && (
              <div style={{ color: "#333", fontSize: "11px", lineHeight: 1.6 }}>No configuration needed for this node type.</div>
            )}

            {/* ── Output panel (shown after execution) ── */}
            {nodeOutputs[selectedNode.id] && (
              <div style={{ marginTop: "16px", padding: "10px", background: "#0a0a0a", border: "1px solid #10b98133", borderRadius: "6px" }}>
                <div style={{ fontSize: "9px", color: "#10b981", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>Last Output</div>
                <pre style={{ fontSize: "9px", color: "#888", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: "120px", overflow: "auto", margin: 0 }}>
                  {JSON.stringify(nodeOutputs[selectedNode.id], null, 2)}
                </pre>
              </div>
            )}

            <button onClick={() => deleteNode(selectedNode.id)}
              style={{ width: "100%", marginTop: "16px", padding: "8px", background: "transparent", border: "1px solid #1f1f1f", color: "#ef4444", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit", transition: "all 0.15s" }}
              onMouseEnter={e => { e.currentTarget.style.background = "#ef444411"; e.currentTarget.style.borderColor = "#ef444444"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "#1f1f1f"; }}>
              Delete Node
            </button>
          </div>
        )}
      </div>

      {/* ── WORKFLOW EXTRACTOR MODAL ── */}
      {showExtractor && (
        <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}
          onClick={e => { if (e.target === e.currentTarget) setShowExtractor(false); }}>
          <div style={{ background: "#0f0f0f", border: "1px solid #1f1f1f", borderRadius: "12px", width: "100%", maxWidth: "720px", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.8)" }}>

            {/* Modal header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #1a1a1a" }}>
              <div>
                <div style={{ fontSize: "14px", color: "#e5e5e5", fontWeight: "600" }}>⊕ Workflow Extractor</div>
                <div style={{ fontSize: "10px", color: "#555", marginTop: "2px" }}>Analyse any project or website and extract its workflows as nodes</div>
              </div>
              <button onClick={() => setShowExtractor(false)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "20px", lineHeight: 1 }}>×</button>
            </div>

            <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
              {/* Input type selector */}
              <div style={{ display: "flex", gap: "6px", marginBottom: "14px" }}>
                {[["url", "🌐 Website URL"], ["code", "{ } Paste Code"], ["describe", "✏ Describe Project"]].map(([t, label]) => (
                  <button key={t} onClick={() => setExtInputType(t)} style={{ padding: "5px 14px", background: extInputType === t ? "#10b98118" : "transparent", border: `1px solid ${extInputType === t ? "#10b98155" : "#222"}`, color: extInputType === t ? "#10b981" : "#555", borderRadius: "5px", cursor: "pointer", fontSize: "10px", fontFamily: "inherit", transition: "all 0.15s" }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Input field */}
              {extInputType === "url" && (
                <input type="text" value={extInput} onChange={e => setExtInput(e.target.value)}
                  placeholder="https://github.com/user/repo  or  https://n8n.io  or  https://myapp.com"
                  style={{ width: "100%", padding: "10px 14px", background: "#111", border: "1px solid #222", borderRadius: "7px", color: "#e5e5e5", fontSize: "12px", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                  onKeyDown={e => e.key === "Enter" && analyzeWorkflow()} />
              )}
              {extInputType === "code" && (
                <textarea value={extInput} onChange={e => setExtInput(e.target.value)}
                  placeholder={"Paste your source code here...\n\n// e.g. your backend routes, config files, package.json, etc."}
                  rows={8} style={{ width: "100%", padding: "10px 14px", background: "#111", border: "1px solid #222", borderRadius: "7px", color: "#e5e5e5", fontSize: "11px", fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }} />
              )}
              {extInputType === "describe" && (
                <textarea value={extInput} onChange={e => setExtInput(e.target.value)}
                  placeholder={"Describe your project in plain English...\n\nExample: An e-commerce store that sends order confirmations via email, posts to Slack when stock is low, and uses AI to auto-generate product descriptions."}
                  rows={5} style={{ width: "100%", padding: "10px 14px", background: "#111", border: "1px solid #222", borderRadius: "7px", color: "#e5e5e5", fontSize: "12px", fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.7 }} />
              )}

              {/* Analyse button */}
              <button onClick={analyzeWorkflow} disabled={extAnalyzing || !extInput.trim()}
                style={{ marginTop: "12px", width: "100%", padding: "10px", background: extAnalyzing || !extInput.trim() ? "#1a1a1a" : "#10b981", border: "none", color: extAnalyzing || !extInput.trim() ? "#555" : "#000", borderRadius: "7px", cursor: extAnalyzing || !extInput.trim() ? "not-allowed" : "pointer", fontSize: "12px", fontWeight: "700", fontFamily: "inherit", transition: "all 0.2s" }}>
                {extAnalyzing ? "⟳  Analysing with Claude…" : "⊕  Analyse & Extract Workflows"}
              </button>

              {/* Results */}
              {extResults && (
                <div style={{ marginTop: "20px" }}>
                  {/* Project summary */}
                  <div style={{ padding: "12px 14px", background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: "8px", marginBottom: "16px" }}>
                    <div style={{ fontSize: "12px", color: "#e5e5e5", fontWeight: "600", marginBottom: "4px" }}>{extResults.projectName}</div>
                    <div style={{ fontSize: "11px", color: "#666", lineHeight: 1.6 }}>{extResults.summary}</div>
                    <div style={{ marginTop: "8px", fontSize: "10px", color: "#444" }}>
                      {extResults.detectedWorkflows?.length} workflows detected · {Object.values(extSelected).filter(Boolean).length} nodes selected
                    </div>
                  </div>

                  {/* Detected workflows */}
                  {(extResults.detectedWorkflows || []).map((wf, wi) => (
                    <div key={wi} style={{ marginBottom: "14px", border: "1px solid #1a1a1a", borderRadius: "8px", overflow: "hidden" }}>
                      {/* Workflow header */}
                      <div style={{ padding: "10px 14px", background: "#111", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <span style={{ fontSize: "11px", color: "#ccc", fontWeight: "600" }}>{wf.name}</span>
                          <span style={{ fontSize: "10px", color: "#555", marginLeft: "10px" }}>{wf.description}</span>
                        </div>
                        <button onClick={() => {
                          const allKey = (wf.nodes || []).map((_, ni) => `${wi}_${ni}`);
                          const allSel = allKey.every(k => extSelected[k]);
                          setExtSelected(prev => { const n = { ...prev }; allKey.forEach(k => n[k] = !allSel); return n; });
                        }} style={{ padding: "3px 10px", background: "transparent", border: "1px solid #2a2a2a", color: "#666", borderRadius: "4px", cursor: "pointer", fontSize: "9px", fontFamily: "inherit" }}>
                          {(wf.nodes || []).every((_, ni) => extSelected[`${wi}_${ni}`]) ? "Deselect all" : "Select all"}
                        </button>
                      </div>
                      {/* Nodes */}
                      <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                        {(wf.nodes || []).map((node, ni) => {
                          const def = NODE_DEFS[node.type] || NODE_DEFS["http"];
                          const key = `${wi}_${ni}`;
                          const isSel = !!extSelected[key];
                          return (
                            <div key={ni} onClick={() => setExtSelected(prev => ({ ...prev, [key]: !prev[key] }))}
                              style={{ display: "flex", alignItems: "center", gap: "8px", padding: "7px 12px", background: isSel ? `${def.color}12` : "#0a0a0a", border: `1px solid ${isSel ? def.color + "44" : "#1f1f1f"}`, borderRadius: "6px", cursor: "pointer", transition: "all 0.15s", userSelect: "none" }}>
                              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: isSel ? def.color : "#333", transition: "background 0.15s", flexShrink: 0 }} />
                              <div style={{ fontSize: "11px", color: isSel ? def.color : "#555" }}>{def.icon}</div>
                              <div>
                                <div style={{ fontSize: "11px", color: isSel ? "#ddd" : "#555", fontWeight: "500" }}>{node.label || def.label}</div>
                                <div style={{ fontSize: "9px", color: "#444" }}>{node.type}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Modal footer */}
            {extResults && (
              <div style={{ padding: "14px 20px", borderTop: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "10px", color: "#555" }}>
                  {Object.values(extSelected).filter(Boolean).length} nodes selected — click a node to toggle, or use "Select all"
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={() => { setExtResults(null); setExtInput(""); setExtSelected({}); }}
                    style={{ padding: "7px 14px", background: "transparent", border: "1px solid #222", color: "#666", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontFamily: "inherit" }}>
                    Reset
                  </button>
                  <button onClick={addExtractedToCanvas} disabled={Object.values(extSelected).filter(Boolean).length === 0}
                    style={{ padding: "7px 18px", background: Object.values(extSelected).filter(Boolean).length === 0 ? "#1a1a1a" : "#10b981", border: "none", color: Object.values(extSelected).filter(Boolean).length === 0 ? "#555" : "#000", borderRadius: "6px", cursor: "pointer", fontSize: "11px", fontWeight: "700", fontFamily: "inherit" }}>
                    ⊕ Add {Object.values(extSelected).filter(Boolean).length} Nodes to Canvas
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
