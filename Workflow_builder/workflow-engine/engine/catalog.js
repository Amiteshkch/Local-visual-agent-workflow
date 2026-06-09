// catalog.js — canonical node registry for the engine + MCP server.
// Mirrors the studio's TOOL_CATALOG ids/categories (minus React-only fields).
// `serverCapable` = the engine can run it headless (vs browser-only nodes that
// need Pyodide / local file parsing).

const SERVER_CAPABLE = new Set([
  "trigger-manual", "trigger-schedule", "trigger-webhook",
  "api-request", "if-else", "filter", "merge", "wait",
  "set-variable", "text-formatter", "code-js",
  "web-research", "claude-ai", "slack-notify", "output-display",
]);

const NODE_CATALOG = [
  { id: "trigger-manual",    label: "Manual Trigger",      category: "Triggers",   description: "Start the workflow on demand." },
  { id: "trigger-schedule",  label: "Schedule Trigger",    category: "Triggers",   description: "Run on a cron schedule." },
  { id: "trigger-webhook",   label: "Webhook Trigger",     category: "Triggers",   description: "Start via an HTTP POST." },
  { id: "web-research",      label: "Web Research Agent",  category: "Collect",    description: "Build search-engine URLs from content/keywords." },
  { id: "api-request",       label: "HTTP / API Request",  category: "Collect",    description: "GET/POST to any endpoint." },
  { id: "document-extractor",label: "Document Extractor",  category: "Parse",      description: "Extract text from PDF/DOCX/TXT (browser only)." },
  { id: "table-analyzer",    label: "CSV / Table Analyzer",category: "Parse",      description: "Profile CSV/TSV files (browser only)." },
  { id: "if-else",           label: "If / Else",           category: "Logic",      description: "Branch on a JS condition." },
  { id: "filter",            label: "Filter",              category: "Logic",      description: "Halt the branch if a condition is false." },
  { id: "loop",              label: "Loop / Iterator",     category: "Logic",      description: "Iterate downstream per item (browser only)." },
  { id: "merge",             label: "Merge",               category: "Logic",      description: "Combine upstream branch outputs." },
  { id: "wait",              label: "Wait / Delay",        category: "Logic",      description: "Pause for N seconds." },
  { id: "data-cleaner",      label: "Data Cleaner",        category: "Transform",  description: "Scan CSV quality (browser only)." },
  { id: "code-js",           label: "Code (JavaScript)",   category: "Transform",  description: "Transform previousOutput with JS." },
  { id: "set-variable",      label: "Set Variable",        category: "Transform",  description: "Store a value into workflow variables." },
  { id: "text-formatter",    label: "Text Formatter",      category: "Transform",  description: "trim/upper/lower/replace on text." },
  { id: "python-step",       label: "Python / IDE Opener", category: "Analyze",    description: "Run Python (browser only / Pyodide)." },
  { id: "chart-builder",     label: "Chart Builder",       category: "Visualize",  description: "Plot CSV data (browser only)." },
  { id: "classifier",        label: "Classifier / Tagger", category: "Analyze",    description: "Tag files by type/name (browser only)." },
  { id: "insight-summarizer",label: "Insight Summarizer",  category: "Analyze",    description: "Word-frequency over docs (browser only)." },
  { id: "claude-ai",         label: "Claude AI",           category: "AI",         description: "Send a prompt + previous output to an AI model." },
  { id: "ai-suggest",        label: "AI Workflow Suggest", category: "AI",         description: "Suggest tools for a folder (browser only)." },
  { id: "report-writer",     label: "Report Writer",       category: "Synthesize", description: "Generate a markdown report (browser only)." },
  { id: "output-display",    label: "Output Display",      category: "Output",     description: "Collect the final output." },
  { id: "slack-notify",      label: "Slack Notification",  category: "Output",     description: "Post a message to Slack." },
].map(n => ({ ...n, serverCapable: SERVER_CAPABLE.has(n.id) }));

const VALID_IDS = new Set(NODE_CATALOG.map(n => n.id));

module.exports = { NODE_CATALOG, VALID_IDS, SERVER_CAPABLE };
