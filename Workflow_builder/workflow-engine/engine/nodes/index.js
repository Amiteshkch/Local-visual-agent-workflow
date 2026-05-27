// engine/nodes/index.js
// Each handler receives (node, context) and returns { success, output, error }
// context = { previousOutput, credentials, workflowId }

const fetch = require("node-fetch");
const { runWithProviderChain, cliSystemPrompt, detectInstalled, detectOllama } = require("../providers");

// Default fallback chain: try OAuth/CLI first, then Gemini API (handled inline
// in each agent), then Ollama as a last-resort local backstop. Per-agent
// `node.config.providers` overrides this default.
const DEFAULT_CLI_CHAIN = ["claude_cli", "codex_cli", "gemini_cli"];
const DEFAULT_OLLAMA_CHAIN = ["ollama"];

// AbortController timeout wrapper for slow endpoints
async function fetchTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function interpolate(str, ctx) {
  // Replace {{previousOutput.field}} with actual values from context
  if (!str || typeof str !== "string") return str;
  return str.replace(/\{\{(.+?)\}\}/g, (_, key) => {
    const keys = key.trim().split(".");
    let val = ctx;
    for (const k of keys) val = val?.[k];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ─── Email-with-attachment helper (avoids Gmail's 102 KB clip) ────────────────
// Wraps the agent-generated HTML report into a standalone .html file and sends
// it as a Resend attachment, with a small summary body. All <a> links open in a
// new tab via <base target="_blank">. Returns { id } from Resend on success.
function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function buildStandaloneReport({ title, bodyHtml }) {
  // The agent's html_body may already be a full HTML doc OR a fragment. Detect
  // and avoid wrapping twice. <base target="_blank"> makes every <a> open in a
  // new tab when the attachment is opened in a browser.
  const looksLikeFullDoc = /<html[\s>]/i.test(bodyHtml);
  if (looksLikeFullDoc) {
    // Inject <base target="_blank"> into <head> if missing, so links open in new tabs.
    if (!/<base\s/i.test(bodyHtml)) {
      bodyHtml = bodyHtml.replace(/<head([^>]*)>/i, `<head$1><base target="_blank" rel="noopener">`);
    }
    return bodyHtml;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank" rel="noopener">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#fafafa; color:#222; margin:0; padding:20px; }
  a { color:#0b5fff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  table { border-collapse: collapse; }
  th, td { vertical-align: top; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
function buildSummaryEmail({ title, agentLabel, analyzed, totalFound, attachmentName, today, extraNote }) {
  const analyzedLine = (typeof analyzed === "number" && typeof totalFound === "number")
    ? `Analyzed <b>${analyzed}</b> of <b>${totalFound}</b> ${agentLabel} found today.`
    : `Full ${agentLabel} report ready.`;
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#fafafa;color:#222;padding:18px 20px;line-height:1.55;font-size:14px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e3e3e8;border-radius:10px;padding:22px 26px">
    <div style="font-size:18px;font-weight:700;margin-bottom:6px">${escapeHtml(title)}</div>
    <div style="font-size:12px;color:#666;margin-bottom:18px">${escapeHtml(today || "")}</div>

    <div style="font-size:14px;margin-bottom:14px">${analyzedLine}</div>
    ${extraNote ? `<div style="font-size:13px;color:#555;margin-bottom:14px">${extraNote}</div>` : ""}

    <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:12px 14px;margin:14px 0">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">📎 Full report attached: <code>${escapeHtml(attachmentName)}</code></div>
      <div style="font-size:12px;color:#555">Open the attachment in your browser — every position title, application URL, HR email, and LinkedIn link is clickable.</div>
    </div>

    <div style="font-size:11px;color:#888;margin-top:16px;border-top:1px solid #eee;padding-top:10px">
      Why attached? Gmail clips inline emails larger than ~102 KB and hides the rest. An attachment shows the complete report with all rows and styling preserved.
    </div>
  </div>
</body></html>`;
}
async function sendAgentReportEmail({ resendKey, from, to, subject, fullHtmlBody, title, agentLabel, analyzed, totalFound, today, extraNote, attachmentName, timeoutMs = 30000 }) {
  if (!resendKey) throw new Error("Missing Resend API key");
  const standaloneHtml = buildStandaloneReport({ title: title || subject, bodyHtml: fullHtmlBody });
  const summaryHtml    = buildSummaryEmail({ title: title || subject, agentLabel, analyzed, totalFound, attachmentName, today, extraNote });
  const contentB64     = Buffer.from(standaloneHtml, "utf8").toString("base64");

  const res = await fetchTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: summaryHtml,
      attachments: [{ filename: attachmentName, content: contentB64 }],
    }),
  }, timeoutMs);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.message || `Resend error ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

// ─── Report renderers (deterministic HTML from structured agent output) ───────
// The agents produce a JSON array of items instead of raw HTML — we build the
// HTML here so every analyzed item is guaranteed to appear in the report.
function tierStyle(tier) {
  const t = String(tier || "").toLowerCase();
  if (t.startsWith("high"))    return { bg:"#d4edda", border:"#28a745", header:"#1e7e34", emoji:"🟢", label:"High" };
  if (t.startsWith("medium"))  return { bg:"#fff3cd", border:"#ffc107", header:"#856404", emoji:"🟡", label:"Medium" };
  if (t.startsWith("low"))     return { bg:"#ffe8cc", border:"#fd7e14", header:"#995008", emoji:"🟠", label:"Low" };
  return                              { bg:"#f0f0f0", border:"#6c757d", header:"#555555", emoji:"⚪", label:"Minimal" };
}
function tierKey(t) {
  const s = String(t || "").toLowerCase();
  if (s.startsWith("high"))   return "High";
  if (s.startsWith("medium")) return "Medium";
  if (s.startsWith("low"))    return "Low";
  return "Minimal";
}
function groupByTier(items, tierField) {
  const groups = { High:[], Medium:[], Low:[], Minimal:[] };
  for (const x of items) groups[tierKey(x[tierField])].push(x);
  return groups;
}
function linkifyEscape(s) {
  // Escape text content and turn bare URLs into clickable links
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  const out = [];
  let last = 0, m;
  while ((m = urlRe.exec(s)) !== null) {
    if (m.index > last) out.push(escapeHtml(s.slice(last, m.index)));
    const url = m[0].replace(/[).,;:!?]+$/, ""); // strip trailing punctuation
    out.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
    last = m.index + url.length;
    urlRe.lastIndex = last;
  }
  if (last < s.length) out.push(escapeHtml(s.slice(last)));
  return out.join("");
}
function arrCell(v) {
  if (v == null) return "—";
  const a = Array.isArray(v) ? v : [v];
  const items = a.map(s => String(s || "").trim()).filter(Boolean).map(linkifyEscape);
  return items.length ? items.join("<br>") : "—";
}
function safeUrlLink(url, label) {
  if (!url) return escapeHtml(label || "—");
  const u = escapeHtml(url);
  return `<a href="${u}">${escapeHtml(label || url)}</a>`;
}
function safeMailto(email, label) {
  if (!email) return "—";
  const e = escapeHtml(String(email).replace(/^likely:\s*/i, ""));
  return `<a href="mailto:${e}">${escapeHtml(label || email)}</a>`;
}
function reportShellCss() {
  return `<style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#fafafa; color:#222; margin:0; padding:24px; line-height:1.5; }
    h1 { font-size:22px; margin:0 0 4px; }
    h2 { font-size:16px; margin:24px 0 10px; padding:8px 12px; border-radius:6px; }
    .meta { font-size:12px; color:#666; margin-bottom:18px; }
    .summary { background:#fff; border:1px solid #e3e3e8; border-radius:8px; padding:14px 18px; margin-bottom:18px; font-size:14px; }
    .summary b { font-size:16px; }
    table { border-collapse: collapse; width:100%; font-size:12px; background:#fff; }
    th, td { border:1px solid #d6d6dc; padding:8px 10px; vertical-align:top; text-align:left; }
    th { font-weight:600; }
    a { color:#0b5fff; text-decoration:none; word-break:break-word; }
    a:hover { text-decoration:underline; }
    .tier-section { margin-bottom:26px; overflow-x:auto; }
    .card { background:#fff; border:1px solid #d6d6dc; border-left-width:5px; border-radius:8px; padding:14px 18px; margin-bottom:14px; }
    .card-head { font-weight:700; font-size:14px; margin-bottom:6px; }
    .card-meta { font-size:11px; color:#666; margin-bottom:8px; }
    .kv { display:grid; grid-template-columns: 180px 1fr; gap:4px 14px; font-size:12px; }
    .kv dt { color:#666; }
    .kv dd { margin:0; }
    .footer { margin-top:30px; font-size:11px; color:#888; border-top:1px solid #e3e3e8; padding-top:12px; }
  </style>`;
}

function renderJobReportHtml(jobs, meta) {
  const groups = groupByTier(jobs, "likely_match");
  // Sort within each tier by similarity_pct desc
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => (b.similarity_pct || 0) - (a.similarity_pct || 0));

  const summary = `Total: <b>${jobs.length}</b> &nbsp;|&nbsp; 🟢 High: <b>${groups.High.length}</b> &nbsp;|&nbsp; 🟡 Medium: <b>${groups.Medium.length}</b> &nbsp;|&nbsp; 🟠 Low: <b>${groups.Low.length}</b>${groups.Minimal.length ? ` &nbsp;|&nbsp; ⚪ Minimal: <b>${groups.Minimal.length}</b>` : ""}`;

  function row(j) {
    return `<tr>
      <td>${safeUrlLink(j.url, j.title || "—")}<div style="font-size:10px;color:#888;margin-top:2px">${escapeHtml(j.posted_at || "")}</div></td>
      <td>${escapeHtml(j.company || "—")}</td>
      <td>${escapeHtml(j.location || "—")}</td>
      <td style="text-align:center"><b>${escapeHtml(String(j.similarity_pct ?? "—"))}%</b></td>
      <td style="text-align:center">${escapeHtml(j.likely_match || "—")}</td>
      <td style="text-align:center">${escapeHtml(String(j.selection_probability_pct ?? "—"))}%</td>
      <td>${escapeHtml(j.hr_name || "—")}</td>
      <td>${safeMailto(j.hr_email)}</td>
      <td>${j.hr_linkedin ? `<a href="${escapeHtml(j.hr_linkedin)}">Search →</a>` : "—"}</td>
      <td>${arrCell(j.key_requirements)}</td>
      <td>${arrCell(j.matched_skills)}</td>
      <td>${arrCell(j.skills_to_develop)}</td>
      <td>${arrCell(j.prep_plan)}</td>
      <td>${arrCell(j.resources)}</td>
    </tr>`;
  }

  function section(tierName, items) {
    if (!items.length) return "";
    const t = tierStyle(tierName);
    return `<div class="tier-section">
      <h2 style="background:${t.bg};color:${t.header};border-left:5px solid ${t.border}">${t.emoji} ${t.label} Match — ${items.length} position${items.length===1?"":"s"}</h2>
      <table>
        <thead><tr style="background:${t.bg}">
          <th>Title (link) &amp; Posted</th><th>Company</th><th>Location</th>
          <th>Sim%</th><th>Match</th><th>Sel%</th>
          <th>👤 HR Name</th><th>📧 HR Email</th><th>🔗 LinkedIn</th>
          <th>Key Requirements</th><th>Matched Skills</th><th>Skills to Develop</th><th>Prep Plan</th><th>Resources</th>
        </tr></thead>
        <tbody>${items.map(row).join("")}</tbody>
      </table>
    </div>`;
  }

  return `${reportShellCss()}
  <h1>🔍 ${escapeHtml(meta.title || "Job Report")}</h1>
  <div class="meta">${escapeHtml(meta.today || "")}${meta.totalFound != null ? ` &middot; Analyzed ${jobs.length} of ${meta.totalFound} found` : ""}</div>
  <div class="summary">${summary}</div>
  ${section("High",    groups.High)}
  ${section("Medium",  groups.Medium)}
  ${section("Low",     groups.Low)}
  ${section("Minimal", groups.Minimal)}
  <div class="footer">Generated ${escapeHtml(new Date().toLocaleString())} &middot; ${escapeHtml(meta.footer || "Job search agent")}</div>`;
}

function renderPostdocReportHtml(positions, meta) {
  const groups = groupByTier(positions, "match_tier");
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => (b.similarity_pct || 0) - (a.similarity_pct || 0));

  const counts = `Total: <b>${positions.length}</b> &nbsp;|&nbsp; 🟢 High: <b>${groups.High.length}</b> &nbsp;|&nbsp; 🟡 Medium: <b>${groups.Medium.length}</b> &nbsp;|&nbsp; 🟠 Low: <b>${groups.Low.length}</b> &nbsp;|&nbsp; ⚪ Minimal: <b>${groups.Minimal.length}</b>`;

  function row(p) {
    return `<tr>
      <td>${safeUrlLink(p.url, p.title || "—")}</td>
      <td>${escapeHtml(p.faculty_pi || "—")}</td>
      <td>${escapeHtml(p.lab || "—")}</td>
      <td>${escapeHtml(p.department || "—")}</td>
      <td>${escapeHtml(p.university || p.institution || "—")}</td>
      <td>${escapeHtml(p.location || "—")}</td>
      <td>${escapeHtml(p.posted || "—")}</td>
      <td>${escapeHtml(p.expiry || "—")}</td>
      <td>${escapeHtml(p.project_duration || "—")}</td>
      <td style="text-align:center"><b>${escapeHtml(String(p.similarity_pct ?? "—"))}%</b></td>
      <td style="text-align:center">${escapeHtml(p.match_tier || "—")}</td>
      <td style="text-align:center">${escapeHtml(String(p.selection_pct ?? "—"))}%</td>
      <td>${arrCell(p.key_requirements)}</td>
      <td>${arrCell(p.matched_skills)}</td>
      <td>${arrCell(p.skills_to_develop)}</td>
      <td>${arrCell(p.key_highlights)}</td>
      <td>${arrCell(p.prep_plan)}</td>
      <td>${arrCell(p.resources)}</td>
    </tr>`;
  }

  function section(tierName, items) {
    if (!items.length) return "";
    const t = tierStyle(tierName);
    return `<div class="tier-section">
      <h2 style="background:${t.bg};color:${t.header};border-left:5px solid ${t.border}">${t.emoji} ${t.label} Match — ${items.length} position${items.length===1?"":"s"}</h2>
      <table>
        <thead><tr style="background:${t.bg}">
          <th>Title (link)</th><th>Faculty/PI</th><th>Lab</th><th>Department</th><th>University</th><th>Location</th>
          <th>Posted</th><th>Expiry</th><th>Duration</th>
          <th>Sim%</th><th>Match</th><th>Sel%</th>
          <th>Key Requirements</th><th>Matched Skills</th><th>Skills to Develop</th><th>Key Highlights</th><th>Prep Plan</th><th>Resources</th>
        </tr></thead>
        <tbody>${items.map(row).join("")}</tbody>
      </table>
    </div>`;
  }

  return `${reportShellCss()}
  <h1>🎓 ${escapeHtml(meta.title || "Postdoc & Research Positions Report")}</h1>
  <div class="meta">${escapeHtml(meta.today || "")}${meta.totalFound != null ? ` &middot; Analyzed ${positions.length} of ${meta.totalFound} found` : ""}</div>
  <div class="summary">${counts}</div>
  ${section("High",    groups.High)}
  ${section("Medium",  groups.Medium)}
  ${section("Low",     groups.Low)}
  ${section("Minimal", groups.Minimal)}
  <div class="footer">Generated ${escapeHtml(new Date().toLocaleString())} &middot; Sorted by location priority: Singapore → USA → Europe → Middle East → South Korea → Australia → Japan → China → India</div>`;
}

function renderResearcherReportHtml(researchers, meta) {
  const groups = groupByTier(researchers, "likely_match");
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => (b.match_pct || 0) - (a.match_pct || 0));

  const counts = `Total: <b>${researchers.length}</b> &nbsp;|&nbsp; 🟢 High: <b>${groups.High.length}</b> &nbsp;|&nbsp; 🟡 Medium: <b>${groups.Medium.length}</b> &nbsp;|&nbsp; 🟠 Low: <b>${groups.Low.length}</b> &nbsp;|&nbsp; ⚪ Minimal: <b>${groups.Minimal.length}</b>`;

  function card(r) {
    const t = tierStyle(r.likely_match);
    const name = escapeHtml(r.name || "—");
    const inst = [r.institution, r.department].filter(Boolean).map(escapeHtml).join(" · ");
    const country = escapeHtml(r.country || "—");
    const profileLink = r.profile_url ? `<a href="${escapeHtml(r.profile_url)}">Profile</a>` : "";
    const orcidLink = r.orcid ? `<a href="https://orcid.org/${escapeHtml(r.orcid.replace(/^https?:\/\/orcid.org\//, ""))}">${escapeHtml(r.orcid)}</a>` : "—";
    const links = [profileLink, orcidLink !== "—" ? orcidLink : ""].filter(Boolean).join(" &middot; ") || "—";
    return `<div class="card" style="border-left-color:${t.border}">
      <div class="card-head">${t.emoji} ${name} <span style="font-weight:400;color:#666">— ${inst}</span></div>
      <div class="card-meta">${country} &middot; ${escapeHtml(r.opportunity_type || "Researcher")} &middot; Match <b>${escapeHtml(String(r.match_pct ?? "—"))}%</b> &middot; Hiring probability: ${escapeHtml(r.hiring_probability || "Unknown")}</div>
      <dl class="kv">
        <dt>📧 Contact</dt><dd>${safeMailto(r.contact_email)}</dd>
        <dt>🔗 Links</dt><dd>${links}</dd>
        <dt>🔬 Topics</dt><dd>${arrCell(r.topics)}</dd>
        <dt>💰 Funding</dt><dd>${escapeHtml(r.funding_info || "—")}</dd>
        <dt>📢 Hiring Signal</dt><dd>${escapeHtml(r.hiring_signal || "—")}</dd>
        <dt>🎓 Fellowship Eligibility</dt><dd>${escapeHtml(r.fellowship_eligibility || "—")}</dd>
        <dt>📅 Expected Start</dt><dd>${escapeHtml(r.expected_start || "—")}</dd>
        <dt>⏳ Project Duration</dt><dd>${escapeHtml(r.project_duration || "—")}</dd>
        <dt>🛂 Visa / Nationality</dt><dd>${escapeHtml(r.nationality_visa || "—")}</dd>
        <dt>🛠 Key Skills Required</dt><dd>${arrCell(r.key_skills_required)}</dd>
        <dt>📚 Skills to Develop</dt><dd>${arrCell(r.skills_to_develop)}</dd>
        <dt>🔖 Resources</dt><dd>${arrCell(r.resources)}</dd>
        <dt>💡 Project Highlights</dt><dd>${escapeHtml(r.project_highlights || "—")}</dd>
        <dt>📨 Contact Strategy</dt><dd>${escapeHtml(r.contact_strategy || "—")}</dd>
      </dl>
    </div>`;
  }

  function section(tierName, items) {
    if (!items.length) return "";
    const t = tierStyle(tierName);
    return `<div class="tier-section">
      <h2 style="background:${t.bg};color:${t.header};border-left:5px solid ${t.border}">${t.emoji} ${t.label} Match — ${items.length} researcher${items.length===1?"":"s"}</h2>
      ${items.map(card).join("")}
    </div>`;
  }

  return `${reportShellCss()}
  <h1>🔬 ${escapeHtml(meta.title || "Researcher & Funding Opportunity Report")}</h1>
  <div class="meta">${escapeHtml(meta.today || "")}${meta.totalFound != null ? ` &middot; Analyzed ${researchers.length} of ${meta.totalFound} found` : ""}</div>
  <div class="summary">${counts}</div>
  ${section("High",    groups.High)}
  ${section("Medium",  groups.Medium)}
  ${section("Low",     groups.Low)}
  ${section("Minimal", groups.Minimal)}
  <div class="footer">Generated ${escapeHtml(new Date().toLocaleString())} &middot; Sources: OpenAlex · CORDIS EU · NIH Reporter · Web Search</div>`;
}

// ─── Trigger Nodes ────────────────────────────────────────────────────────────
async function runManual(node, context) {
  return { success: true, output: { triggered: true, timestamp: new Date().toISOString(), source: "manual" } };
}

async function runWebhook(node, context) {
  // Webhook triggers come in via POST /api/webhook/:path — data is in context.webhookData
  const data = context.webhookData || { note: "No webhook data — trigger via POST /api/webhook/" + (node.config.path || "trigger") };
  return { success: true, output: data };
}

async function runSchedule(node, context) {
  return { success: true, output: { triggered: true, timestamp: new Date().toISOString(), cron: node.config.cron } };
}

// ─── AI Node — multi-provider ─────────────────────────────────────────────────
async function runClaude(node, context) {
  const {
    provider    = "anthropic",
    prompt      = "You are a helpful assistant.",
    userMessage = "Hello!",
    model       = "",
    max_tokens  = "1000",
    ollamaUrl   = "http://localhost:11434",
  } = node.config;

  const resolvedMessage = interpolate(userMessage, { previousOutput: context.previousOutput });
  const maxTok = parseInt(max_tokens) || 1000;

  // ── Anthropic (Claude) ──────────────────────────────────────────────────────
  if (provider === "anthropic") {
    const apiKey = context.credentials?.anthropicApiKey;
    if (!apiKey) throw new Error("Missing Anthropic API key — add it in Settings");
    const mdl = model || "claude-sonnet-4-20250514";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: mdl, max_tokens: maxTok, system: prompt, messages: [{ role: "user", content: resolvedMessage }] }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `Anthropic error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { reply: data.content?.[0]?.text || "", provider: "anthropic", model: mdl, tokensUsed: data.usage?.output_tokens } };
  }

  // ── OpenAI (ChatGPT) ────────────────────────────────────────────────────────
  if (provider === "openai") {
    const apiKey = context.credentials?.openaiApiKey;
    if (!apiKey) throw new Error("Missing OpenAI API key — add it in Settings");
    const mdl = model || "gpt-4o";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model: mdl, max_tokens: maxTok, messages: [{ role: "system", content: prompt }, { role: "user", content: resolvedMessage }] }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `OpenAI error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { reply: data.choices?.[0]?.message?.content || "", provider: "openai", model: mdl, tokensUsed: data.usage?.completion_tokens } };
  }

  // ── Google Gemini ───────────────────────────────────────────────────────────
  if (provider === "gemini") {
    const apiKey = context.credentials?.geminiApiKey;
    if (!apiKey) throw new Error("Missing Gemini API key — add it in Settings");
    const mdl = model || "gemini-2.0-flash";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt}\n\n${resolvedMessage}` }] }], generationConfig: { maxOutputTokens: maxTok } }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e?.error?.message || `Gemini error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { reply: data.candidates?.[0]?.content?.parts?.[0]?.text || "", provider: "gemini", model: mdl } };
  }

  // ── Ollama (local / open-source) ────────────────────────────────────────────
  if (provider === "ollama") {
    const mdl = model || "llama3";
    const baseUrl = (context.credentials?.ollamaUrl || ollamaUrl).replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: mdl, stream: false, messages: [{ role: "system", content: prompt }, { role: "user", content: resolvedMessage }] }),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status} — is Ollama running at ${baseUrl}?`);
    const data = await res.json();
    return { success: true, output: { reply: data.message?.content || "", provider: "ollama", model: mdl } };
  }

  // ── OpenAI-compatible (any custom endpoint) ─────────────────────────────────
  if (provider === "openai-compatible") {
    const apiKey  = context.credentials?.customApiKey || "";
    const baseUrl = (context.credentials?.customBaseUrl || "").replace(/\/$/, "");
    if (!baseUrl) throw new Error("Missing Custom Base URL — add customBaseUrl in credentials");
    const mdl = model || "default";
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: mdl, max_tokens: maxTok, messages: [{ role: "system", content: prompt }, { role: "user", content: resolvedMessage }] }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>{}); throw new Error(e?.error?.message || `API error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { reply: data.choices?.[0]?.message?.content || "", provider: "openai-compatible", model: mdl } };
  }

  throw new Error(`Unknown provider: "${provider}". Choose: anthropic, openai, gemini, ollama, openai-compatible`);
}

// ─── Slack ────────────────────────────────────────────────────────────────────
async function runSlack(node, context) {
  const { operation = "Send Message", channel = "#general", message = "Hello!" } = node.config;
  const token = context.credentials?.slackToken;
  if (!token) throw new Error("Missing Slack Bot Token in credentials");

  const resolvedMessage = interpolate(message, { previousOutput: context.previousOutput });

  if (operation === "Send Message") {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text: resolvedMessage }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Slack API error");
    return { success: true, output: { messageTs: data.ts, channel: data.channel } };
  } else {
    const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=10`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Slack API error");
    return { success: true, output: { messages: data.messages || [], count: data.messages?.length || 0 } };
  }
}

// ─── Gmail ────────────────────────────────────────────────────────────────────
async function runGmail(node, context) {
  const { operation = "Get Emails", to = "", subject = "", body = "" } = node.config;
  const token = context.credentials?.gmailToken;
  if (!token) throw new Error("Missing Gmail OAuth token in credentials");

  if (operation === "Get Emails" || operation === "Search Emails") {
    const q  = operation === "Search Emails" ? "is:unread" : "in:inbox";
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=${encodeURIComponent(q)}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Gmail error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { messages: data.messages || [], total: data.resultSizeEstimate } };
  } else {
    if (!to) throw new Error("No recipient — set 'To' in node config");
    const resolvedBody    = interpolate(body, { previousOutput: context.previousOutput });
    const resolvedSubject = interpolate(subject, { previousOutput: context.previousOutput });
    const raw = Buffer.from(`To: ${to}\r\nSubject: ${resolvedSubject}\r\nContent-Type: text/plain\r\n\r\n${resolvedBody}`)
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Gmail error ${res.status}`); }
    const data = await res.json();
    return { success: true, output: { messageId: data.id, to, subject: resolvedSubject } };
  }
}

// ─── HTTP Request ─────────────────────────────────────────────────────────────
async function runHTTP(node, context) {
  const { method = "GET", url = "", body: reqBody = "" } = node.config;
  if (!url) throw new Error("No URL — configure the HTTP node");

  const resolvedUrl = interpolate(url, { previousOutput: context.previousOutput });
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (reqBody && method !== "GET") {
    try { opts.body = JSON.stringify(JSON.parse(reqBody)); } catch { opts.body = reqBody; }
  }

  const res  = await fetch(resolvedUrl, opts);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { success: true, output: { status: res.status, statusText: res.statusText, data: parsed } };
}

// ─── Transform (JS eval in sandbox) ──────────────────────────────────────────
async function runTransform(node, context) {
  const { code = "return previousOutput;" } = node.config;
  try {
    // Safe-ish eval: only exposes previousOutput
    const fn = new Function("previousOutput", code);
    const result = fn(context.previousOutput);
    return { success: true, output: result };
  } catch (err) {
    throw new Error("Transform error: " + err.message);
  }
}

// ─── If / Else ────────────────────────────────────────────────────────────────
async function runIfElse(node, context) {
  const { condition = "true" } = node.config;
  try {
    const resolvedCond = interpolate(condition, { previousOutput: context.previousOutput });
    const fn = new Function("previousOutput", `return !!(${resolvedCond});`);
    const result = fn(context.previousOutput);
    return { success: true, output: { condition: resolvedCond, result, branch: result ? "true" : "false" } };
  } catch (err) {
    throw new Error("Condition error: " + err.message);
  }
}

// ─── Merge ────────────────────────────────────────────────────────────────────
async function runMerge(node, context) {
  return { success: true, output: { merged: true, data: context.previousOutput } };
}

// ─── Researcher / Faculty Discovery Search ────────────────────────────────────
async function runResearcherSearch(node, context) {
  const keywords = node.config?.keywords || [
    "computational fluid dynamics turbulence",
    "rheology complex fluids non-Newtonian",
    "heat transfer mass transfer simulation",
    "spray atomization droplet evaporation",
    "viscoelastic polymer fluid mechanics",
    "machine learning fluid dynamics simulation",
  ];

  const LOC_PRIORITY = {
    SG:1, US:2, CA:2, GB:3, DE:3, NL:3, FR:3, SE:3, CH:3, BE:3, DK:3, NO:3, FI:3, AT:3, IT:3, ES:3,
    SA:4, AE:4, QA:4, KR:5, AU:6, NZ:7, JP:8, CN:9, IN:10,
  };
  const LOC_NAME = {
    SG:"Singapore", US:"USA", CA:"Canada", GB:"UK", DE:"Germany", NL:"Netherlands", FR:"France",
    SE:"Sweden", CH:"Switzerland", BE:"Belgium", DK:"Denmark", NO:"Norway", AT:"Austria",
    IT:"Italy", ES:"Spain", SA:"Saudi Arabia", AE:"UAE", QA:"Qatar", KR:"South Korea",
    AU:"Australia", NZ:"New Zealand", JP:"Japan", CN:"China", IN:"India",
  };
  const PRIORITY_COUNTRIES = new Set(Object.keys(LOC_PRIORITY));

  const researchers = [];
  const seen = new Set();

  function addResearcher(r) {
    if (!r.name || r.name.length < 3) return;
    const key = r.name.toLowerCase().trim().slice(0, 50);
    if (seen.has(key)) return;
    seen.add(key);
    r.locationPriority = LOC_PRIORITY[r.countryCode] || 99;
    r.countryName      = LOC_NAME[r.countryCode]     || r.countryCode || "Unknown";
    researchers.push(r);
  }

  const OA_HEADERS = { "User-Agent": "https://github.com/Amiteshkch" };

  // ── 1. OpenAlex — works search → extract top authors from priority countries
  for (const kw of keywords) {
    try {
      // Search recent papers by keyword
      const worksUrl = `https://api.openalex.org/works?search=${encodeURIComponent(kw)}&filter=publication_year:>2022&sort=cited_by_count:desc&per-page=25&select=id,authorships`;
      const wRes = await fetchTimeout(worksUrl, { headers: OA_HEADERS }, 20000);
      if (!wRes.ok) continue;
      const wData = await wRes.json();

      // Collect unique author IDs from priority countries
      const authorIds = new Map(); // id → {name, institution, country}
      for (const work of (wData.results || [])) {
        for (const authorship of (work.authorships || [])) {
          const author = authorship.author;
          const insts  = authorship.institutions || [];
          const inst   = insts[0];
          const cc     = inst?.country_code || "";
          if (author?.id && PRIORITY_COUNTRIES.has(cc) && !authorIds.has(author.id)) {
            authorIds.set(author.id, {
              name:    author.display_name || "",
              instName: inst?.display_name || "",
              instUrl:  inst?.homepage_url || "",
              cc,
            });
          }
        }
      }

      // Batch-fetch author profiles via OpenAlex filter (much faster than one-by-one)
      const ids = [...authorIds.keys()].slice(0, 30).map(id => id.replace("https://openalex.org/",""));
      if (!ids.length) continue;
      try {
        const batchUrl = `https://api.openalex.org/authors?filter=openalex_id:${ids.join("|")}&per-page=30&select=id,display_name,orcid,last_known_institutions,works_count,cited_by_count,topics`;
        const bRes = await fetchTimeout(batchUrl, { headers: OA_HEADERS }, 20000);
        if (bRes.ok) {
          const bData = await bRes.json();
          for (const a of (bData.results || [])) {
            const inst   = a.last_known_institutions?.[0];
            const cc     = inst?.country_code || "";
            if (!PRIORITY_COUNTRIES.has(cc)) continue;
            // Domain relevance: must match engineering/fluid keywords AND not be purely biomedical
            const topicStr = (a.topics || []).map(t => t.display_name).join(" ").toLowerCase();
            const isEngineeringFluid = /fluid|rheol|heat\s+transfer|thermal\s+simul|spray|combustion|turbulence|polymer\s+flow|openfoam|ansys|cfd|atomiz|droplet|viscous|multiphase|non.newtonian|mass\s+transfer|colloid|suspension|granular|emulsion|microfluidic|particle.laden|soft.matter|interfacial|wetting|capillar|surfactant|jet.break|spray.cool|droplet.dynam/i.test(topicStr + " " + kw);
            const isPurelyBiomedical = /cardiac|aortic|vascular|cardiovascular|cancer|tumor|clinical|hospital|surgery|oncol|genomics|biomed|neurosci|pharma|dental|ophthalmol/i.test(topicStr) && !isEngineeringFluid;
            if (!isEngineeringFluid || isPurelyBiomedical) continue;
            addResearcher({
              name:          a.display_name,
              orcid:         a.orcid || "",
              institution:   inst?.display_name || "",
              department:    "",
              countryCode:   cc,
              institutionUrl: inst?.homepage_url || "",
              email:         "",
              profileUrl:    `https://openalex.org/${a.id?.split("/").pop()}`,
              topics:        (a.topics || []).slice(0, 5).map(t => t.display_name),
              worksCount:    a.works_count    || 0,
              citedByCount:  a.cited_by_count || 0,
              fundingInfo:   "",
              hiringSignal:  "",
              source:        "OpenAlex",
              searchKeyword: kw,
            });
          }
        }
      } catch (e) { console.log(`[ResearcherSearch] OpenAlex batch failed: ${e.message}`); }
    } catch (e) { console.log(`[ResearcherSearch] OpenAlex "${kw}" failed: ${e.message}`); }
  }

  // ── 2. NIH Reporter — active US grants ────────────────────────────────────
  const nihKws = ["computational fluid dynamics", "rheology polymer fluid", "heat transfer evaporation fluid", "colloidal suspension dynamics", "granular flow particle", "droplet emulsion microfluidics", "droplet dynamics jet breakup", "spray cooling thermal"];
  for (const kw of nihKws) {
    try {
      const res = await fetchTimeout("https://api.reporter.nih.gov/v2/projects/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          criteria: {
            advanced_text_search: { operator: "and", search_field: "all", search_text: kw },
            project_start_date: { from_date: "2023-01-01" },
          },
          limit: 20, offset: 0,
          fields: ["project_title","pi_names","organization","project_start_date","project_end_date","award_amount"],
        }),
      }, 20000);
      if (!res.ok) continue;
      const data = await res.json();
      for (const proj of (data.results || [])) {
        const pi = proj.pi_names?.[0];
        if (!pi) continue;
        const piName = `${pi.first_name || ""} ${pi.last_name || ""}`.trim();
        addResearcher({
          name:          piName,
          orcid:         "",
          institution:   proj.organization?.org_name || "",
          department:    proj.organization?.org_department || "",
          countryCode:   "US",
          institutionUrl: "",
          email:         "",
          profileUrl:    "",
          topics:        [kw, "NIH Funded Research"],
          worksCount:    0,
          citedByCount:  0,
          fundingInfo:   `NIH grant: "${proj.project_title?.slice(0,70)}" | $${Math.round((proj.award_amount||0)/1000)}k | ${proj.project_start_date?.slice(0,7)} → ${proj.project_end_date?.slice(0,7)}`,
          hiringSignal:  "Active NIH-funded lab — postdoc positions common with active grants",
          source:        "NIH Reporter",
          searchKeyword: kw,
        });
      }
    } catch (e) { console.log(`[ResearcherSearch] NIH "${kw}" failed: ${e.message}`); }
  }

  // ── 3. OpenAlex — direct author search by institution type (universities) ──
  const directSearches = [
    "fluid dynamics rheology",
    "spray combustion heat transfer",
    "non-newtonian multiphase flow",
    "colloid suspension granular dynamics",
    "droplet emulsion microfluidics soft matter",
  ];
  for (const kw of directSearches) {
    try {
      // Use author text search
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(kw)}&filter=publication_year:>2023,type:journal-article&sort=cited_by_count:desc&per-page=20&select=id,authorships`;
      const res = await fetchTimeout(url, { headers: OA_HEADERS }, 20000);
      if (!res.ok) continue;
      const data = await res.json();
      for (const work of (data.results || [])) {
        for (const a of (work.authorships || []).slice(0, 3)) {
          const inst = (a.institutions || [])[0];
          const cc   = inst?.country_code || "";
          if (!PRIORITY_COUNTRIES.has(cc) || !a.author?.display_name) continue;
          addResearcher({
            name:          a.author.display_name,
            orcid:         "",
            institution:   inst?.display_name || "",
            department:    "",
            countryCode:   cc,
            institutionUrl: inst?.homepage_url || "",
            email:         "",
            profileUrl:    a.author.id ? `https://openalex.org/${a.author.id.split("/").pop()}` : "",
            topics:        [kw],
            worksCount:    0,
            citedByCount:  0,
            fundingInfo:   "",
            hiringSignal:  "Active researcher — recent 2023+ publication",
            source:        "OpenAlex (recent papers)",
            searchKeyword: kw,
          });
        }
      }
    } catch (e) { console.log(`[ResearcherSearch] OpenAlex direct "${kw}" failed: ${e.message}`); }
  }

  // Sort by location priority (Singapore first, India last)
  researchers.sort((a, b) => (a.locationPriority || 99) - (b.locationPriority || 99));
  console.log(`[ResearcherSearch] Found ${researchers.length} researchers/PIs`);

  // Pre-save raw results to storage so GUI always has the full list
  // (Gemini's save_structured_results may not cover all researchers due to output limits)
  try {
    const fsModule   = require("fs").promises;
    const pathModule = require("path");
    const rawPath    = pathModule.join(__dirname, "..", "..", "storage", "researcher-results.json");
    // Build minimal GUI-compatible records with match_pct=0 (Gemini will overwrite with real scores)
    const rawRecords = researchers.map(r => ({
      name:                   r.name,
      institution:            r.institution,
      department:             r.department || "",
      country:                r.countryName || r.countryCode || "",
      contact_email:          r.email || "",
      orcid:                  r.orcid || "",
      profile_url:            r.profileUrl || "",
      topics:                 r.topics || [],
      match_pct:              0,
      likely_match:           "Pending",
      hiring_probability:     "",
      fellowship_eligibility: "",
      expected_start:         "",
      project_duration:       "",
      key_skills_required:    [],
      skills_to_develop:      [],
      resources:              [],
      funding_info:           r.fundingInfo || "",
      hiring_signal:          r.hiringSignal || "",
      project_highlights:     "",
      contact_strategy:       "",
    }));
    // Merge with existing scored results (keep Gemini scores for researchers already analyzed)
    let existing = [];
    try { existing = JSON.parse(await fsModule.readFile(rawPath, "utf8")).researchers || []; } catch {}
    const scoredMap = new Map(existing.filter(r => r.match_pct > 0).map(r => [r.name.toLowerCase(), r]));
    const merged    = rawRecords.map(r => scoredMap.get(r.name.toLowerCase()) || r);
    await fsModule.writeFile(rawPath, JSON.stringify({ researchers: merged, savedAt: new Date().toISOString(), totalAnalyzed: merged.length }, null, 2));
    console.log(`[ResearcherSearch] Pre-saved ${merged.length} researchers to GUI results file`);
  } catch (e) { console.log(`[ResearcherSearch] Pre-save failed: ${e.message}`); }

  return { success: true, output: { researchers, count: researchers.length, fetchedAt: new Date().toISOString() } };
}

// ─── Researcher / Faculty Agent (Gemini) ──────────────────────────────────────
async function runResearcherAgent(node, context) {
  const geminiKey = context.credentials?.geminiApiKey;  // optional now — provider chain falls back if missing

  const model   = node.config?.model || "gemini-flash-latest";
  const toEmail = node.config?.to    || context.credentials?.gmailUser;
  if (!toEmail) throw new Error("Missing 'to' email in researcheragent config");

  const today = new Date().toLocaleDateString("en-IN", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });

  const CV = node.config?.cvSummary || "";
  const allResearchers = context.previousOutput?.researchers || [];

  // Include all researchers (2% threshold = no filter)
  const researchers = allResearchers.slice(0, 80);

  const resJson = JSON.stringify(researchers.map(r => ({
    name: r.name, institution: r.institution, department: r.department,
    country: r.countryName || r.countryCode, email: r.email, orcid: r.orcid,
    profileUrl: r.profileUrl, institutionUrl: r.institutionUrl,
    topics: r.topics, worksCount: r.worksCount, citedByCount: r.citedByCount,
    fundingInfo: r.fundingInfo, hiringSignal: r.hiringSignal,
    source: r.source, keyword: r.searchKeyword,
  })));

  const SYSTEM = `You are an expert academic career advisor helping a PhD researcher find postdoc/research opportunities by identifying the most active and relevant researchers worldwide. Today: ${today}.

CANDIDATE CV:
${CV}

CANDIDATE BACKGROUND NOTE:
- Indian national (PhD from India) → eligible for: MSCA Individual Fellowship (moving to EU), Alexander von Humboldt (Germany), JSPS (Japan), NRF (Singapore), DST-SERB (India), Newton-Bhabha (UK)
- NOT eligible for fellowships requiring prior EU citizenship for outgoing phases

TASK — analyze each researcher/PI and produce a complete report:

For EACH researcher, assess:
1. match_pct: skill/topic overlap with candidate (minimum 2% — include everything)
2. likely_match: High(≥60%), Medium(30-59%), Low(10-29%), Minimal(2-9%)
3. opportunity_type: "Postdoc", "Research Associate", "Collaboration", "Fellowship Host", "Industry R&D"
4. hiring_probability: High/Medium/Low/Unknown — based on active funding, recent hiring signals
5. fellowship_eligibility: list relevant fellowships (MSCA-IF, Humboldt Georg Forster, JSPS, NRF Singapore, etc.) with brief eligibility note
6. expected_start: best guess from funding dates or "Not specified"
7. project_duration: from grant end dates or "Typically 2-3 years postdoc"
8. nationality_visa: any visa/nationality info if known, else "Check with PI directly"
9. key_skills_required: top 3-4 skills needed based on their research topics
10. skills_to_develop: gaps between candidate and this researcher's work (be specific)
11. resources: 2-3 specific courses/papers/tools to bridge the gap
12. contact_strategy: specific advice — what to mention, how to approach, best email subject line
13. contact_email: use provided email or construct likely format (firstname.lastname@institution.edu) — never leave blank
14. project_highlights: key points about their research relevant to candidate

LOCATION PRIORITY (sort report in this order): Singapore → USA → Europe → Middle East → South Korea → Australia → Japan → China → India

WORKFLOW — two tool calls, in order:

1. Call save_structured_results with the COMPLETE researchers[] array — EVERY researcher with ≥2% match. Do NOT drop anyone, do NOT summarize. If you analyzed 80 researchers, the array must contain 80 entries. Include ALL these fields per researcher: name, institution, department, country, contact_email, orcid, profile_url, topics[], match_pct, likely_match ("High"|"Medium"|"Low"|"Minimal"), opportunity_type, hiring_probability, fellowship_eligibility, expected_start, project_duration, nationality_visa, key_skills_required[], skills_to_develop[], resources[], funding_info, hiring_signal, project_highlights, contact_strategy. Use "Not specified" for unknown strings, [] for empty arrays.

2. Call send_email_report with just the subject line. The HTML email is built automatically from the array you provided to save_structured_results — you do NOT need to construct HTML.`;

  const TOOLS = [
    {
      name: "save_structured_results",
      description: "Save the FULL analyzed researcher array. Must include EVERY researcher analyzed — do not skip or summarize.",
      input_schema: {
        type: "object",
        properties: {
          researchers: {
            type: "array",
            description: "Array of EVERY analyzed researcher (≥2% match). Do not stop early or include placeholders.",
            items: {
              type: "object",
              properties: {
                name:                  { type: "string" },
                institution:           { type: "string" },
                department:            { type: "string" },
                country:               { type: "string" },
                contact_email:         { type: "string" },
                orcid:                 { type: "string" },
                profile_url:           { type: "string" },
                topics:                { type: "array", items: { type: "string" } },
                match_pct:             { type: "number" },
                likely_match:          { type: "string", description: "High, Medium, Low, or Minimal" },
                opportunity_type:      { type: "string" },
                hiring_probability:    { type: "string" },
                fellowship_eligibility:{ type: "string" },
                expected_start:        { type: "string" },
                project_duration:      { type: "string" },
                nationality_visa:      { type: "string" },
                key_skills_required:   { type: "array", items: { type: "string" } },
                skills_to_develop:     { type: "array", items: { type: "string" } },
                resources:             { type: "array", items: { type: "string" } },
                funding_info:          { type: "string" },
                hiring_signal:         { type: "string" },
                project_highlights:    { type: "string" },
                contact_strategy:      { type: "string" },
              },
              required: ["name","institution","match_pct","likely_match"],
            },
          },
        },
        required: ["researchers"],
      },
    },
    {
      name: "send_email_report",
      description: "Send the researcher email after save_structured_results. Email body is rendered from the saved array. Pass ONLY the subject.",
      input_schema: { type:"object", properties: { subject:{type:"string"} }, required:["subject"] },
    },
  ];
  const GEMINI_TOOLS = [{ function_declarations: TOOLS.map(t => ({ name:t.name, description:t.description, parameters:t.input_schema })) }];

  let lastScoredResearchers = [];  // populated by save_structured_results, consumed by send_email_report

  const userMsg = `Analyze ALL ${researchers.length} researchers below (from ${allResearchers.length} total, sorted by location priority Singapore→India). Include every one with ≥2% match.\n\nSTEPS:\n1. Call save_structured_results with the full researchers[] array (one entry per researcher, all fields filled).\n2. Call send_email_report({ subject: "..." }) — the HTML report is built from the array you just saved.\n\nRESEARCHERS:\n${resJson}`;
  const geminiContents = [{ role:"user", parts:[{ text:userMsg }] }];

  // ─── Helper: render + send researcher email from an args object (CLI/Ollama paths) ──
  async function researcherSendFromArgs(args, providerUsed, latencyMs) {
    const datePart = new Date().toISOString().slice(0, 10);
    const list     = Array.isArray(args.researchers) ? args.researchers : [];
    const subject  = args.subject || `🔬 Researcher & Funding Opportunity Report — ${today}`;
    console.log(`[ResearcherAgent] (${providerUsed}) Rendering HTML for ${list.length} structured researchers`);

    // Side effect: also persist to disk so the GUI keeps its results file in sync
    try {
      const fsModule   = require("fs").promises;
      const pathModule = require("path");
      const resultsPath = pathModule.join(__dirname, "..", "..", "storage", "researcher-results.json");
      let existing = [];
      try { existing = JSON.parse(await fsModule.readFile(resultsPath, "utf8")).researchers || []; } catch {}
      const scoredMap = new Map(list.map(r => [String(r.name || "").toLowerCase().trim(), r]));
      const merged = existing.length ? existing.map(r => scoredMap.get(String(r.name||"").toLowerCase().trim()) || r) : list.slice();
      for (const [key, r] of scoredMap) if (!merged.find(e => String(e.name||"").toLowerCase().trim() === key)) merged.push(r);
      merged.sort((a, b) => (b.match_pct || 0) - (a.match_pct || 0));
      await fsModule.writeFile(resultsPath, JSON.stringify({ researchers: merged, savedAt: new Date().toISOString(), totalAnalyzed: merged.length }, null, 2));
    } catch (e) {
      console.warn(`[ResearcherAgent] persist to disk failed (non-fatal): ${e.message}`);
    }

    const fullHtml = renderResearcherReportHtml(list, { title: subject, today, totalFound: allResearchers.length });
    await sendAgentReportEmail({
      resendKey:      context.credentials?.resendApiKey,
      from:           "Researcher Scout <onboarding@resend.dev>",
      to:             toEmail,
      subject,
      fullHtmlBody:   fullHtml,
      title:          subject,
      agentLabel:     "researchers",
      analyzed:       list.length,
      totalFound:     allResearchers.length,
      today,
      attachmentName: `researcher-report-${datePart}.html`,
      extraNote:      `Generated via <b>${providerUsed}</b>${latencyMs ? ` in ${(latencyMs/1000).toFixed(1)} s` : ""} · ${list.length} researchers · Sources: OpenAlex · CORDIS EU · NIH Reporter · Web Search.`,
    });
    return { emailSent: true, providerUsed, researchersReported: list.length, totalFound: allResearchers.length };
  }

  const stageAttempts = [];

  // ─── STAGE 1: OAuth/CLI providers ────────────────────────────────────────
  // The CLI prompt asks for a single tool call that bundles the analyzed array;
  // it's a one-shot replacement for the multi-turn save+send sequence.
  const cliChain = node.config?.cliChain || DEFAULT_CLI_CHAIN;
  const cliSchemaTail = `\n\nNote: emit ONE tool call named "send_email_report". The args object must contain:\n  - subject (string)\n  - researchers (array) — the FULL analyzed researcher array (every analyzed entry, all fields filled).`;
  try {
    const r = await runWithProviderChain({
      systemPrompt:     cliSystemPrompt(SYSTEM + cliSchemaTail, "send_email_report"),
      userPrompt:       userMsg,
      expectedToolName: "send_email_report",
      chain:            cliChain,
      timeoutMs:        300000,
      logPrefix:        "[ResearcherAgent/CLI]",
    });
    const out = await researcherSendFromArgs(r.args, r.providerUsed, r.latencyMs);
    return { success: true, output: { ...out, stage: "cli", cliAttempts: r.attempts } };
  } catch (cliErr) {
    stageAttempts.push({ stage: "cli", error: String(cliErr.message || cliErr).slice(0, 300), inner: cliErr.attempts });
    console.warn(`[ResearcherAgent] CLI chain failed → trying Gemini API. ${String(cliErr.message || cliErr).slice(0, 200)}`);
  }

  // ─── STAGE 2: Existing Gemini API multi-turn loop (function calling) ─────
  if (!geminiKey) {
    console.warn(`[ResearcherAgent] No Gemini API key — skipping Stage 2, going to Ollama.`);
  } else { try {

  let emailSent = false, turns = 0;
  let tokIn = 0, tokOut = 0, tokTotal = 0;
  while (turns < 10 && !emailSent) {
    if (turns > 0) await new Promise(r => setTimeout(r, 13000));
    let responseData, activeModel;
    try {
      ({ data: responseData, model: activeModel } = await callGeminiWithFallback(geminiKey, model, () => ({
        system_instruction: { parts:[{ text:SYSTEM }] },
        contents:   geminiContents,
        tools:      GEMINI_TOOLS,
        tool_config: { function_calling_config:{ mode:"ANY" } },
        generationConfig: { maxOutputTokens:65536, thinkingConfig: { thinkingBudget: 0 } },
      }), 90000));
    } catch (e) { throw new Error(`All Gemini models unavailable: ${e.message}`); }

    const u = responseData.usageMetadata || {};
    tokIn    += u.promptTokenCount      || 0;
    tokOut   += u.candidatesTokenCount  || 0;
    tokTotal += u.totalTokenCount       || 0;

    const modelParts = responseData.candidates?.[0]?.content?.parts || [];
    geminiContents.push({ role:"model", parts:modelParts });
    turns++;

    const fnCalls = modelParts.filter(p => p.functionCall);
    console.log(`[ResearcherAgent] Turn ${turns} | model:${activeModel} | tools:${fnCalls.length} | tokens in:${u.promptTokenCount||0} out:${u.candidatesTokenCount||0} total:${u.totalTokenCount||0}`);
    if (!fnCalls.length) break;

    const responseParts = [];
    for (const part of fnCalls) {
      const { name, args } = part.functionCall;
      if (name === "save_structured_results") {
        try {
          const fsModule   = require("fs").promises;
          const pathModule = require("path");
          const resultsPath = pathModule.join(__dirname, "..", "..", "storage", "researcher-results.json");
          const geminiScored = (args.researchers || []);
          lastScoredResearchers = geminiScored;  // consumed by send_email_report

          // Read pre-saved full list (all researchers from researchersearch)
          let existing = [];
          try { existing = JSON.parse(await fsModule.readFile(resultsPath, "utf8")).researchers || []; } catch {}

          // Apply Gemini's scores onto the full list (merge, don't overwrite)
          const scoredMap = new Map(geminiScored.map(r => [r.name.toLowerCase().trim(), r]));
          const merged = existing.length > 0
            ? existing.map(r => scoredMap.get(r.name.toLowerCase().trim()) || r)
            : geminiScored;
          // Also add any Gemini researchers missing from the pre-saved list
          for (const [key, r] of scoredMap) {
            if (!merged.find(e => e.name.toLowerCase().trim() === key)) merged.push(r);
          }
          // Sort: scored (match_pct > 0) first, then pending
          merged.sort((a, b) => (b.match_pct || 0) - (a.match_pct || 0));

          await fsModule.writeFile(resultsPath, JSON.stringify({ researchers: merged, savedAt: new Date().toISOString(), totalAnalyzed: merged.length }, null, 2));
          console.log(`[ResearcherAgent] Merged ${merged.length} researchers (${geminiScored.length} scored by Gemini)`);
          responseParts.push({ functionResponse:{ name, response:{ saved:true, total:merged.length, scored:geminiScored.length } } });
        } catch (e) {
          responseParts.push({ functionResponse:{ name, response:{ error:e.message } } });
        }
      } else if (name === "send_email_report") {
        if (!lastScoredResearchers.length) {
          responseParts.push({ functionResponse:{ name, response:{ error:"Call save_structured_results first with the full researchers array." } } });
          continue;
        }
        const datePart = new Date().toISOString().slice(0, 10);
        console.log(`[ResearcherAgent] Rendering HTML for ${lastScoredResearchers.length} structured researchers`);
        const fullHtml = renderResearcherReportHtml(lastScoredResearchers, { title: args.subject, today, totalFound: allResearchers.length });
        await sendAgentReportEmail({
          resendKey:      context.credentials?.resendApiKey,
          from:           "Researcher Scout <onboarding@resend.dev>",
          to:             toEmail,
          subject:        args.subject,
          fullHtmlBody:   fullHtml,
          title:          args.subject,
          agentLabel:     "researchers",
          analyzed:       lastScoredResearchers.length,
          totalFound:     allResearchers.length,
          today,
          attachmentName: `researcher-report-${datePart}.html`,
          extraNote:      `Full report attached: ${lastScoredResearchers.length} researchers with profile/ORCID/email links. Sources: OpenAlex · CORDIS EU · NIH Reporter · Web Search.`,
        });
        emailSent = true;
        console.log(`[ResearcherAgent] Email sent to ${toEmail} (${lastScoredResearchers.length} researchers)`);
        responseParts.push({ functionResponse:{ name, response:{ sent:true, researchersReported:lastScoredResearchers.length } } });
      } else {
        responseParts.push({ functionResponse:{ name, response:{ error:"Unknown tool" } } });
      }
    }
    geminiContents.push({ role:"user", parts:responseParts });
  }

  console.log(`[ResearcherAgent] TOTAL tokens — in:${tokIn} out:${tokOut} total:${tokTotal} over ${turns} turn(s) | model:${model}`);
  if (emailSent) {
    return { success:true, output:{ emailSent, agentTurns:turns, model, researchersAnalyzed:researchers.length, totalFound:allResearchers.length, tokensIn:tokIn, tokensOut:tokOut, tokensTotal:tokTotal, stage: "gemini_api" } };
  }
  throw new Error(`Gemini API loop ended without sending email (turns=${turns})`);

  } catch (gemErr) {
    stageAttempts.push({ stage: "gemini_api", error: String(gemErr.message || gemErr).slice(0, 300) });
    console.warn(`[ResearcherAgent] Gemini API failed → trying Ollama. ${String(gemErr.message || gemErr).slice(0, 200)}`);
  } }

  // ─── STAGE 3: Ollama (local model) as final backstop ─────────────────────
  try {
    const ollamaModel = node.config?.ollamaModel || context.credentials?.ollamaModel || "qwen2.5:3b";
    const r = await runWithProviderChain({
      systemPrompt:     cliSystemPrompt(SYSTEM + cliSchemaTail, "send_email_report"),
      userPrompt:       userMsg,
      expectedToolName: "send_email_report",
      chain:            DEFAULT_OLLAMA_CHAIN,
      timeoutMs:        900000,
      providerOptions:  { ollama: { model: ollamaModel } },
      logPrefix:        "[ResearcherAgent/Ollama]",
    });
    const out = await researcherSendFromArgs(r.args, `${r.providerUsed} (${ollamaModel})`, r.latencyMs);
    return { success: true, output: { ...out, stage: "ollama", allAttempts: stageAttempts.concat(r.attempts) } };
  } catch (ollamaErr) {
    stageAttempts.push({ stage: "ollama", error: String(ollamaErr.message || ollamaErr).slice(0, 300) });
  }

  throw new Error(`All provider stages failed for researcher agent. Attempts: ${JSON.stringify(stageAttempts)}`);
}

// ─── Academic / Postdoc Search ────────────────────────────────────────────────
async function runAcademicSearch(node, context) {
  const jobs = [];
  const seen = new Set();

  // Location priority order (1 = highest)
  const LOC_PRIORITY = {
    "singapore":     1, "united states": 2, "usa": 2, "us": 2, "canada": 2,
    "europe":        3, "uk": 3, "united kingdom": 3, "germany": 3,
    "netherlands":   3, "france": 3, "sweden": 3, "switzerland": 3,
    "denmark": 3, "belgium": 3, "spain": 3, "italy": 3, "norway": 3,
    "middle east":   4, "saudi arabia": 4, "uae": 4, "qatar": 4, "kuwait": 4,
    "south korea":   5, "korea": 5,
    "australia":     6,
    "new zealand":   7,
    "japan":         8,
    "china":         9,
    "india":         10,
  };

  function locPriority(location) {
    const l = (location || "").toLowerCase();
    for (const [key, pri] of Object.entries(LOC_PRIORITY)) {
      if (l.includes(key)) return pri;
    }
    return 5; // default mid-priority
  }

  function decHtml(s) {
    return (s || "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
      .replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n)).trim();
  }

  function addJob(job) {
    if (!job.title || job.title.length < 4) return;
    const key = `${job.title.toLowerCase().slice(0,55)}|${(job.company||"").toLowerCase().slice(0,30)}`;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ ...job, locationPriority: locPriority(job.location), id: jobs.length + 1 });
  }

  const LI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Domain keyword sets
  const DOMAIN_QUERIES = [
    "postdoc computational fluid dynamics",
    "postdoctoral researcher CFD simulation",
    "research associate rheology complex fluids",
    "postdoc heat transfer thermal fluid",
    "postdoctoral position machine learning fluid dynamics",
    "research fellow spray atomization combustion",
    "postdoc non-newtonian polymer fluid",
    "research associate OpenFOAM CFD",
    "postdoc droplet dynamics jet breakup",
    "research associate spray cooling thermal management",
  ];

  // Priority locations for LinkedIn
  // Reduced to 8 priority locations to keep total search time under 3 minutes
  const LOCATIONS = [
    "Singapore", "United States", "Canada", "Europe",
    "South Korea", "Australia", "Japan", "India",
  ];

  // Run searches: each domain query × each location (rate-limited)
  for (const q of DOMAIN_QUERIES) {
    for (const loc of LOCATIONS) {
      try {
        const params = new URLSearchParams({ keywords: q, location: loc, f_TPR: "r2592000" }); // last 30 days
        const res = await fetchTimeout(`https://www.linkedin.com/jobs/search/?${params}`, { headers: LI_HEADERS }, 8000);
        if (!res.ok) continue;
        const html = await res.text();

        const titles    = [...html.matchAll(/class="base-search-card__title"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g)].map(m => decHtml(m[1].replace(/<[^>]+>/g,"").trim()));
        const companies = [...html.matchAll(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g)].map(m => decHtml(m[1].replace(/<[^>]+>/g,"").trim()));
        const locs      = [...html.matchAll(/class="job-search-card__location"[^>]*>\s*([\s\S]*?)\s*<\/span>/g)].map(m => decHtml(m[1].trim()));
        const urls      = [...html.matchAll(/"(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"&]+)/g)].map(m => m[1]);
        const dates     = [...html.matchAll(/datetime="([^"]+)"/g)].map(m => m[1]);

        for (let i = 0; i < titles.length; i++) {
          if (!titles[i]) continue;
          // Only include clearly academic/research positions
          const t = titles[i].toLowerCase();
          if (!/(postdoc|research.associat|research.fellow|research.scientist|phd.position|doctoral|faculty|lecturer|professor|scientist|engineer)/i.test(t)) continue;
          addJob({
            title:       titles[i],
            company:     companies[i] || "Institution",
            location:    locs[i]     || loc,
            url:         urls[i]     || "",
            description: `LinkedIn Academic. Search: "${q}" | Location: ${loc}`,
            source:      "LinkedIn Academic",
            postedAt:    dates[i]    || new Date().toISOString(),
            searchQuery: q,
          });
        }
      } catch (e) { /* silent — partial results are fine */ }
    }
    // Small delay to avoid LinkedIn rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // Sort by location priority (Singapore first, India last)
  jobs.sort((a, b) => (a.locationPriority || 99) - (b.locationPriority || 99));

  console.log(`[AcademicSearch] Found ${jobs.length} postdoc/research positions`);
  return { success: true, output: { jobs, count: jobs.length, fetchedAt: new Date().toISOString() } };
}

// ─── Postdoc Agent (Gemini — academic analysis with 10% threshold) ────────────
async function runPostdocAgent(node, context) {
  const nodemailer = require("nodemailer");

  const provider  = node.config?.provider || "gemini";
  const geminiKey = context.credentials?.geminiApiKey;  // optional now — provider chain falls back if missing

  const model   = node.config?.model || "gemini-flash-latest";
  const toEmail = node.config?.to    || context.credentials?.gmailUser;
  if (!toEmail) throw new Error("Missing 'to' email in postdocagent node config");

  const today = new Date().toLocaleDateString("en-IN", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });

  const CV = node.config?.cvSummary || "";

  // At 5% threshold — send ALL positions to Gemini (already sorted by location priority)
  const allJobs = context.previousOutput?.jobs || [];
  const jobs = allJobs.slice(0, 50); // cap at 50 so Gemini can complete analysis within 90s

  const LOC_LABEL = { 1:"🇸🇬 Singapore", 2:"🇺🇸 USA", 3:"🇪🇺 Europe", 4:"🕌 Middle East",
                      5:"🇰🇷 South Korea", 6:"🇦🇺 Australia", 7:"🇳🇿 New Zealand",
                      8:"🇯🇵 Japan", 9:"🇨🇳 China", 10:"🇮🇳 India" };

  const jobsJson = JSON.stringify(jobs.map(j => ({
    id: j.id, title: j.title, institution: j.company,
    location: j.location, locationPriority: j.locationPriority,
    url: j.url, postedAt: j.postedAt,
    description: (j.description||"").slice(0, 300),
  })));

  const SYSTEM = `You are an academic career advisor analyzing postdoc/research positions for a PhD researcher. Today: ${today}.

CANDIDATE PROFILE:
${CV}

IMPORTANT RULES:
- Include EVERY position where skill overlap is ≥10% — do not exclude anything
- Match threshold is VERY LOW intentionally (10%) so candidate sees all opportunities
- Be generous in scoring — if even 1-2 skills match, include it
- For academic positions, extract: faculty/PI name, lab name, department, university name from title/description (mark "Not specified" if not found)
- Date posted: use postedAt field; format as DD-MMM-YYYY
- Expiry date: extract from description if mentioned, else "Not specified"
- Project duration: extract from description if mentioned, else "Not specified"
- Key highlights: 3 most important points about the role/project

LOCATION PRIORITY (sort output in this order):
1. Singapore  2. USA  3. Europe  4. Middle East  5. South Korea
6. Australia  7. New Zealand  8. Japan  9. China  10. India

MATCH LEVELS:
- High: ≥70% similarity
- Medium: 40–69%
- Low: 20–39%
- Minimal: 5–19% (still include — candidate wants to see ALL options, even weak matches)
- Include EVERY position — even 5% overlap is worth showing

Call send_email_report ONCE with STRUCTURED DATA (NOT html). The HTML email is rendered by the server from your positions[] array.

CRITICAL: positions[] must contain EVERY analyzed position with ≥5% match. Do not stop early, do not summarize, do not drop entries. If you analyzed 50 positions, the array must contain 50 items.

Each item must include ALL of these fields (use "Not specified" for strings you cannot determine, [] for empty arrays):
  - title (string)
  - url (string) — full https URL to the listing if known; else preserve from input
  - faculty_pi (string)
  - lab (string)
  - department (string)
  - university (string)
  - institution (string) — same as university or umbrella institute
  - location (string)
  - posted (string) — date posted as DD-MMM-YYYY
  - expiry (string)
  - project_duration (string)
  - similarity_pct (integer 0-100)
  - match_tier (string) — exactly "High", "Medium", "Low", or "Minimal"
  - selection_pct (integer 0-100)
  - key_requirements (array of strings)
  - matched_skills (array of strings)
  - skills_to_develop (array of strings)
  - key_highlights (array of 3 strings — most important points)
  - prep_plan (array of strings)
  - resources (array of strings; URLs welcome)`;

  const TOOLS = [
    {
      name: "send_email_report",
      description: "Send the postdoc report. Call ONCE with the full structured array of EVERY analyzed position (server renders HTML).",
      input_schema: {
        type: "object",
        properties: {
          subject:   { type: "string" },
          positions: {
            type: "array",
            description: "Array of EVERY analyzed position — do not skip any.",
            items: {
              type: "object",
              properties: {
                title:             { type: "string" },
                url:               { type: "string" },
                faculty_pi:        { type: "string" },
                lab:               { type: "string" },
                department:        { type: "string" },
                university:        { type: "string" },
                institution:       { type: "string" },
                location:          { type: "string" },
                posted:            { type: "string" },
                expiry:            { type: "string" },
                project_duration:  { type: "string" },
                similarity_pct:    { type: "integer" },
                match_tier:        { type: "string", description: "High, Medium, Low, or Minimal" },
                selection_pct:     { type: "integer" },
                key_requirements:  { type: "array", items: { type: "string" } },
                matched_skills:    { type: "array", items: { type: "string" } },
                skills_to_develop: { type: "array", items: { type: "string" } },
                key_highlights:    { type: "array", items: { type: "string" } },
                prep_plan:         { type: "array", items: { type: "string" } },
                resources:         { type: "array", items: { type: "string" } },
              },
              required: ["title","university","location","similarity_pct","match_tier"],
            },
          },
        },
        required: ["subject", "positions"],
      },
    },
  ];

  const GEMINI_TOOLS = [{ function_declarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];

  const userMsg = `Analyze ALL ${jobs.length} academic positions below (sorted by location priority: Singapore first, India last). Include every single one in the email report — do not skip or truncate any. Send the complete report.\n\nPOSITIONS:\n${jobsJson}`;
  const geminiContents = [{ role: "user", parts: [{ text: userMsg }] }];

  // ─── Shared helper: render + send the email once we have a structured args object ──
  async function postdocSendFromArgs(args, providerUsed, latencyMs) {
    const datePart  = new Date().toISOString().slice(0, 10);
    const positions = Array.isArray(args.positions) ? args.positions : [];
    const subject   = args.subject || `🎓 Postdoc & Research Positions Report — ${today}`;
    console.log(`[PostdocAgent] (${providerUsed}) Rendering HTML for ${positions.length} structured positions`);
    const fullHtml  = renderPostdocReportHtml(positions, { title: subject, today, totalFound: allJobs.length });
    await sendAgentReportEmail({
      resendKey:      context.credentials?.resendApiKey,
      from:           "Postdoc Search Agent <onboarding@resend.dev>",
      to:             toEmail,
      subject,
      fullHtmlBody:   fullHtml,
      title:          subject,
      agentLabel:     "postdoc/research positions",
      analyzed:       positions.length,
      totalFound:     allJobs.length,
      today,
      attachmentName: `postdoc-report-${datePart}.html`,
      extraNote:      `Generated via <b>${providerUsed}</b>${latencyMs ? ` in ${(latencyMs/1000).toFixed(1)} s` : ""} · ${positions.length} positions · sorted by location priority Singapore → USA → Europe → … → India.`,
    });
    return { emailSent: true, providerUsed, positionsReported: positions.length, totalFound: allJobs.length };
  }

  const stageAttempts = [];

  // ─── STAGE 1: OAuth/CLI providers (Claude Code / Codex / Gemini CLI) ───────
  const cliChain = node.config?.cliChain || DEFAULT_CLI_CHAIN;
  try {
    const r = await runWithProviderChain({
      systemPrompt:     cliSystemPrompt(SYSTEM, "send_email_report"),
      userPrompt:       userMsg,
      expectedToolName: "send_email_report",
      chain:            cliChain,
      timeoutMs:        300000,
      logPrefix:        "[PostdocAgent/CLI]",
    });
    const out = await postdocSendFromArgs(r.args, r.providerUsed, r.latencyMs);
    return { success: true, output: { ...out, stage: "cli", cliAttempts: r.attempts } };
  } catch (cliErr) {
    stageAttempts.push({ stage: "cli", error: String(cliErr.message || cliErr).slice(0, 300), inner: cliErr.attempts });
    console.warn(`[PostdocAgent] CLI chain failed → trying Gemini API. ${String(cliErr.message || cliErr).slice(0, 200)}`);
  }

  // ─── STAGE 2: Existing Gemini API multi-turn loop (function calling) ───────
  if (!geminiKey) {
    console.warn(`[PostdocAgent] No Gemini API key — skipping Stage 2, going to Ollama.`);
  } else { try {

  let emailSent = false;
  let turns = 0;
  let tokIn = 0, tokOut = 0, tokTotal = 0;

  while (turns < 10 && !emailSent) {
    if (turns > 0) await new Promise(r => setTimeout(r, 13000));

    let activeModel = model;
    let responseData;
    try {
      ({ data: responseData, model: activeModel } = await callGeminiWithFallback(geminiKey, model, () => ({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents:   geminiContents,
        tools:      GEMINI_TOOLS,
        tool_config: { function_calling_config: { mode: "ANY" } },
        generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
      }), 90000));
    } catch (e) {
      throw new Error(`All Gemini models unavailable: ${e.message}`);
    }

    const u = responseData.usageMetadata || {};
    tokIn    += u.promptTokenCount      || 0;
    tokOut   += u.candidatesTokenCount  || 0;
    tokTotal += u.totalTokenCount       || 0;

    const response = responseData;
    const modelParts = response.candidates?.[0]?.content?.parts || [];
    geminiContents.push({ role: "model", parts: modelParts });
    turns++;

    const fnCalls = modelParts.filter(p => p.functionCall);
    console.log(`[PostdocAgent] Turn ${turns} | model:${activeModel} | tools:${fnCalls.length} | tokens in:${u.promptTokenCount||0} out:${u.candidatesTokenCount||0} total:${u.totalTokenCount||0}`);

    if (!fnCalls.length) break;

    const responseParts = [];
    for (const part of fnCalls) {
      const { name, args } = part.functionCall;
      if (name === "send_email_report") {
        const datePart  = new Date().toISOString().slice(0, 10);
        const positions = Array.isArray(args.positions) ? args.positions : [];
        console.log(`[PostdocAgent] Rendering HTML for ${positions.length} structured positions`);
        const fullHtml  = renderPostdocReportHtml(positions, { title: args.subject, today, totalFound: allJobs.length });
        await sendAgentReportEmail({
          resendKey:      context.credentials?.resendApiKey,
          from:           "Postdoc Search Agent <onboarding@resend.dev>",
          to:             toEmail,
          subject:        args.subject,
          fullHtmlBody:   fullHtml,
          title:          args.subject,
          agentLabel:     "postdoc/research positions",
          analyzed:       positions.length,
          totalFound:     allJobs.length,
          today,
          attachmentName: `postdoc-report-${datePart}.html`,
          extraNote:      `Full report attached: ${positions.length} positions with title links, sorted by location priority Singapore → USA → Europe → … → India.`,
        });
        emailSent = true;
        console.log(`[PostdocAgent] Email sent to ${toEmail} (${positions.length} positions)`);
        responseParts.push({ functionResponse: { name, response: { sent: true, to: toEmail, positionsReported: positions.length } } });
      } else {
        responseParts.push({ functionResponse: { name, response: { error: "Unknown tool" } } });
      }
    }
    geminiContents.push({ role: "user", parts: responseParts });
  }

  console.log(`[PostdocAgent] TOTAL tokens — in:${tokIn} out:${tokOut} total:${tokTotal} over ${turns} turn(s) | model:${model}`);
  if (emailSent) {
    return { success: true, output: { emailSent, agentTurns: turns, model, jobsAnalyzed: jobs.length, totalFound: allJobs.length, tokensIn: tokIn, tokensOut: tokOut, tokensTotal: tokTotal, stage: "gemini_api" } };
  }
  throw new Error(`Gemini API loop ended without sending email (turns=${turns})`);

  } catch (gemErr) {
    stageAttempts.push({ stage: "gemini_api", error: String(gemErr.message || gemErr).slice(0, 300) });
    console.warn(`[PostdocAgent] Gemini API failed → trying Ollama. ${String(gemErr.message || gemErr).slice(0, 200)}`);
  } }

  // ─── STAGE 3: Ollama (local model) as final backstop ───────────────────────
  try {
    const ollamaModel = node.config?.ollamaModel || context.credentials?.ollamaModel || "qwen2.5:3b";
    const r = await runWithProviderChain({
      systemPrompt:     cliSystemPrompt(SYSTEM, "send_email_report"),
      userPrompt:       userMsg,
      expectedToolName: "send_email_report",
      chain:            DEFAULT_OLLAMA_CHAIN,
      timeoutMs:        900000,
      providerOptions:  { ollama: { model: ollamaModel } },
      logPrefix:        "[PostdocAgent/Ollama]",
    });
    const out = await postdocSendFromArgs(r.args, `${r.providerUsed} (${ollamaModel})`, r.latencyMs);
    return { success: true, output: { ...out, stage: "ollama", allAttempts: stageAttempts.concat(r.attempts) } };
  } catch (ollamaErr) {
    stageAttempts.push({ stage: "ollama", error: String(ollamaErr.message || ollamaErr).slice(0, 300) });
  }

  throw new Error(`All provider stages failed for postdoc agent. Attempts: ${JSON.stringify(stageAttempts)}`);
}

// ─── Gemini fallback helper ───────────────────────────────────────────────────
// Tries models in order; skips to next on overload/quota errors
// Model order: non-thinking models first (no thought_signature issues)
const GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash-lite",   // no thinking mode — most reliable for tool use
  "gemini-flash-lite-latest", // lite, usually no thinking
  "gemini-2.5-flash",        // thinking model — may need thought_signature
  "gemini-flash-latest",     // thinking model — may need thought_signature
];

function isGeminiOverload(msg = "") {
  return /high demand|overload|quota|resource.exhausted|RESOURCE_EXHAUSTED|503|429|abort|aborted|timed? ?out|ETIMEDOUT|network|thought_signature|thought signature|functionCall parts/i.test(msg);
}

async function callGeminiWithFallback(geminiKey, preferredModel, requestBodyFn, timeoutMs = 300000) {
  const models = [
    preferredModel,
    ...GEMINI_FALLBACK_MODELS.filter(m => m !== preferredModel),
  ];

  let lastError;
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
      const res = await fetchTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBodyFn(model)),
      }, timeoutMs);

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data?.error) {
        const msg = data?.error?.message || `HTTP ${res.status}`;
        if (isGeminiOverload(msg) || isGeminiOverload(String(res.status))) {
          console.log(`[Gemini] ${model} overloaded — trying next model`);
          lastError = new Error(msg);
          continue;
        }
        throw new Error(msg);
      }

      // Success — check if response itself contains an error (rare but happens)
      if (data?.candidates?.[0]?.finishReason === "ERROR") {
        lastError = new Error("Gemini response error");
        continue;
      }

      console.log(`[Gemini] Using model: ${model}`);
      return { data, model };
    } catch (e) {
      if (isGeminiOverload(e.message)) {
        console.log(`[Gemini] ${model} failed (${e.message.slice(0, 60)}) — trying next`);
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("All Gemini models unavailable");
}

// ─── LinkedIn search helper (shared by jobsearch + jobagent) ─────────────────
async function linkedinJobSearch(query, location = "", remoteOnly = false) {
  function decHtml(s) {
    return (s || "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
      .replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n)).trim();
  }
  const params = new URLSearchParams({ keywords: query, f_TPR: "r604800" });
  if (location)   params.set("location", location);
  if (remoteOnly) params.set("f_WT", "2");

  const res = await fetchTimeout(`https://www.linkedin.com/jobs/search/?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }, 20000);

  if (!res.ok) return { jobs: [], count: 0, error: `LinkedIn ${res.status}` };

  const html      = await res.text();
  const titles    = [...html.matchAll(/class="base-search-card__title"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g)].map(m => decHtml(m[1].replace(/<[^>]+>/g,"").trim()));
  const companies = [...html.matchAll(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g)].map(m => decHtml(m[1].replace(/<[^>]+>/g,"").trim()));
  const locs      = [...html.matchAll(/class="job-search-card__location"[^>]*>\s*([\s\S]*?)\s*<\/span>/g)].map(m => decHtml(m[1].trim()));
  const urls      = [...html.matchAll(/"(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"&]+)/g)].map(m => m[1]);

  const jobs = [];
  const seen = new Set();
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i]) continue;
    const key = `${titles[i].toLowerCase().slice(0,55)}|${(companies[i]||"").toLowerCase().slice(0,30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ title: titles[i], company: companies[i] || "Company", location: locs[i] || location || "Unknown", url: urls[i] || "" });
  }
  return { jobs, count: jobs.length, query, location: location || "global" };
}

// ─── Job Agent (Claude API — agentic loop with tool use) ─────────────────────
async function runJobAgent(node, context) {
  const nodemailer = require("nodemailer");

  // Auto-detect provider from available credentials, or use node config
  const provider  = node.config?.provider ||
    (context.credentials?.anthropicApiKey ? "anthropic" :
     context.credentials?.openaiApiKey    ? "openai"    :
     context.credentials?.geminiApiKey    ? "gemini"    : "anthropic");

  const anthropicKey = context.credentials?.anthropicApiKey;
  const openaiKey    = context.credentials?.openaiApiKey;
  const geminiKey    = context.credentials?.geminiApiKey;

  if (provider === "anthropic" && !anthropicKey) throw new Error("Missing Anthropic API key — add via /api/credentials");
  if (provider === "openai"    && !openaiKey)    throw new Error("Missing OpenAI API key — add via /api/credentials");
  if (provider === "gemini"    && !geminiKey)    throw new Error("Missing Gemini API key — add via /api/credentials");

  const model = node.config?.model || (
    provider === "openai"    ? "gpt-4o-mini" :
    provider === "gemini"    ? "gemini-2.0-flash" :
                               "claude-haiku-4-5-20251001"
  );
  const gmailUser = context.credentials?.gmailUser;
  const gmailPass = context.credentials?.gmailAppPassword;
  const toEmail   = node.config?.to      || gmailUser;
  if (!toEmail) throw new Error("Missing 'to' email in jobagent node config");

  const today = new Date().toLocaleDateString("en-IN", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });

  const CV = node.config?.cvSummary || `
CANDIDATE: Amitesh K Chaudhary | PhD Mechanical Engineering, IISc Bangalore (2018-2025)
CURRENT: Research Associate, IISc — Laser diagnostics for jet-in-crossflow combustion studies

EXPERTISE:
- Complex Fluid Rheology: viscoelastic/shear-thinning polymer solutions (Xanthan gum), MCR302 rheometer (steady/dynamic shear), CaBER-DoS extensional measurements
- Spray & Atomization: Rotary atomization, PDIA, shadowgraphy, Sauter mean diameter, droplet size distributions
- Heat & Mass Transfer: Single droplet evaporation (experimental + 1D transient numerical model, Stefan-flow kinetics)
- CFD/Simulation: Ansys Fluent, OpenFOAM, Comsol
- Machine Learning: CNN with TensorFlow & PyTorch, scikit-learn, image processing with OpenCV
- Laser Diagnostics: PIV, PTV, Shadowgraphy, Schlieren, PDIA, High-speed imaging
- Programming: Python (pandas, numpy, matplotlib, plotly, seaborn), MATLAB
- CAD: SolidWorks, CATIA, Solid Edge, AutoDesk Fusion 360

PUBLICATIONS: 2 conference (ILASS Asia 2022; ICR Rheology Athens 2023); 3 journal papers in progress
AWARDS: PMRF (Prime Minister's Research Fellow) 2018-2023; Top 2% AIEEE 2011
TARGET: Postdoc / Research / Industry in CFD, ML applied to fluid dynamics, heat transfer, complex fluids/rheology
LOCATION: India preferred; Remote acceptable`;

  const SYSTEM = `You are a job-search agent. Today: ${today}.

CANDIDATE: ${CV}

YOU MUST USE TOOLS. Do not respond with text — call linkedin_search immediately.

REQUIRED STEPS:
1. Call linkedin_search 12 times with these exact inputs (call them one by one):
   - query="computational fluid dynamics" location="India"
   - query="CFD simulation engineer" location="India"
   - query="rheology complex fluids scientist" location="India"
   - query="heat transfer thermal simulation" location="India"
   - query="OpenFOAM Ansys Fluent engineer" location="India"
   - query="spray atomization combustion" location="India"
   - query="postdoc mechanical engineering" location="India"
   - query="machine learning fluid dynamics" location=""
   - query="CFD engineer" location="" remote_only=true
   - query="computational fluid dynamics postdoc" location=""
   - query="turbulence simulation researcher" location="India"
   - query="non-newtonian polymer fluids" location=""

2. Deduplicate results by title+company.

3. Analyze each job against the candidate profile:
   similarity_pct (0-100), likely_match (High/Medium/Low), selection_probability_pct,
   key_requirements (top 3), matched_skills, skills_to_develop, prep_plan (3 steps), resources (2-3 links)

4. For each job, provide SPECIFIC HR contact details — not generic taglines:
   - hr_name: The actual name of the HR/Recruiter/Hiring Manager. Use your knowledge of the company's known recruiters. If unknown, write "Search: [First] [Last] - HR [Company]" as a LinkedIn search hint — never write "Talent Acquisition Team" or "HR Department".
   - hr_email: The most likely direct email. Use known company email formats — e.g. for L&T: "firstname.lastname@larsentoubro.com", for Valeo: "firstname.lastname@valeo.com", for Tata: "hr.engineering@tatamotors.com". Format as "likely: hr@company.com" if inferred. Never leave blank.
   - hr_linkedin: Direct LinkedIn search URL to find that HR person — format as "https://www.linkedin.com/search/results/people/?keywords=[Name]+[Company]+recruiter&origin=GLOBAL_SEARCH_HEADER"

5. Call send_email_report ONCE with STRUCTURED DATA (NOT html). The HTML report is built by the server from your array.
   CRITICAL: include EVERY analyzed job in the jobs[] array — do not stop early, do not include "...truncated..." placeholders, do not give "representative samples". If you analyzed 50 jobs, the array MUST contain 50 entries.
   Each item must include ALL of these fields:
     - title (string) — the job title
     - url (string) — full https URL to the job posting (preserve from linkedin_search results)
     - company (string)
     - location (string)
     - posted_at (string) — date posted if known, else ""
     - similarity_pct (integer 0-100)
     - likely_match (string) — must be exactly "High", "Medium", or "Low"
     - selection_probability_pct (integer 0-100)
     - hr_name (string) — actual person's name or "Search: First Last — HR Company" hint; never "Talent Acquisition Team"
     - hr_email (string) — full email address (e.g. "firstname.lastname@company.com"); never empty
     - hr_linkedin (string) — full LinkedIn search URL (https://www.linkedin.com/search/results/people/?keywords=…)
     - key_requirements (array of 3 strings)
     - matched_skills (array of strings)
     - skills_to_develop (array of strings)
     - prep_plan (array of 3 strings)
     - resources (array of 2-3 strings; URLs ok)`;

  const TOOLS = [
    {
      name: "linkedin_search",
      description: "Search LinkedIn Jobs (last 7 days). Returns title, company, location, URL for each posting.",
      input_schema: {
        type: "object",
        properties: {
          query:       { type: "string",  description: "Search keywords e.g. 'CFD engineer fluid dynamics'" },
          location:    { type: "string",  description: "Location filter e.g. 'India', 'Remote', or empty string for global" },
          remote_only: { type: "boolean", description: "true to filter for remote-only positions" },
        },
        required: ["query"],
      },
    },
    {
      name: "send_email_report",
      description: "Send the completed job report email. Call ONCE with the full structured array of all analyzed jobs (server renders the HTML).",
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Email subject line" },
          jobs: {
            type: "array",
            description: "Array of EVERY analyzed job — do not skip or summarize. Each entry must include all listed fields.",
            items: {
              type: "object",
              properties: {
                title:                     { type: "string" },
                url:                       { type: "string", description: "Full https URL to the job posting" },
                company:                   { type: "string" },
                location:                  { type: "string" },
                posted_at:                 { type: "string" },
                similarity_pct:            { type: "integer" },
                likely_match:              { type: "string", description: "Exactly High, Medium, or Low" },
                selection_probability_pct: { type: "integer" },
                hr_name:                   { type: "string" },
                hr_email:                  { type: "string" },
                hr_linkedin:               { type: "string", description: "Full LinkedIn search URL for the HR person" },
                key_requirements:          { type: "array", items: { type: "string" } },
                matched_skills:            { type: "array", items: { type: "string" } },
                skills_to_develop:         { type: "array", items: { type: "string" } },
                prep_plan:                 { type: "array", items: { type: "string" } },
                resources:                 { type: "array", items: { type: "string" } },
              },
              required: ["title","company","location","similarity_pct","likely_match","hr_name","hr_email","hr_linkedin"],
            },
          },
        },
        required: ["subject", "jobs"],
      },
    },
  ];

  async function executeTool(name, input) {
    if (name === "linkedin_search") {
      const result = await linkedinJobSearch(input.query || "", input.location || "", input.remote_only || false);
      console.log(`[JobAgent] linkedin_search("${input.query}", "${input.location||"global"}") → ${result.count} jobs`);
      return result;
    }
    if (name === "send_email_report") {
      const resendKey = context.credentials?.resendApiKey;
      if (!resendKey) throw new Error("Missing Resend API key — get one free at resend.com, then: curl -X POST http://localhost:3001/api/credentials -H 'Content-Type: application/json' -d '{\"resendApiKey\":\"re_...\"}'");
      const fromAddr = context.credentials?.resendFrom || "Job Search Agent <onboarding@resend.dev>";
      const datePart = new Date().toISOString().slice(0, 10);
      const jobsArr  = Array.isArray(input.jobs) ? input.jobs : [];
      console.log(`[JobAgent] Rendering HTML for ${jobsArr.length} structured jobs`);
      const fullHtml = renderJobReportHtml(jobsArr, { title: input.subject, today, totalFound: allPreloaded.length, footer: "Job search agent" });
      const data = await sendAgentReportEmail({
        resendKey,
        from:           fromAddr,
        to:             toEmail,
        subject:        input.subject,
        fullHtmlBody:   fullHtml,
        title:          input.subject,
        agentLabel:     "jobs",
        analyzed:       jobsArr.length,
        totalFound:     allPreloaded.length,
        today,
        attachmentName: `job-report-${datePart}.html`,
        extraNote:      `Full report attached: ${jobsArr.length} jobs with title links, HR mailto: links, and LinkedIn search URLs. All clickable from the file.`,
      });
      console.log(`[JobAgent] Email sent via Resend to ${toEmail} (${jobsArr.length} jobs) — id: ${data?.id || "n/a"}`);
      return { sent: true, to: toEmail, id: data?.id, jobsReported: jobsArr.length };
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  // OpenAI tool schema
  const OAI_TOOLS = TOOLS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // Gemini tool schema
  const GEMINI_TOOLS = [{ function_declarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];

  // If jobs were passed from jobsearch node, pre-filter to top 50 most domain-relevant
  const allPreloaded = context.previousOutput?.jobs || [];
  const searchMode   = allPreloaded.length === 0;

  function scoreJob(job) {
    const t = (job.title + " " + (job.description||"")).toLowerCase();
    let s = 0;
    if (/cfd|computational.fluid/.test(t))          s += 5;
    if (/rheol|non.newtonian|viscoelastic/.test(t)) s += 5;
    if (/fluid.dynam|fluid.mechan/.test(t))         s += 4;
    if (/heat.transfer|thermal.simul/.test(t))      s += 4;
    if (/openfoam|ansys.fluent|comsol/.test(t))     s += 4;
    if (/spray|atomiz|combustion/.test(t))          s += 3;
    if (/turbulence|multiphase/.test(t))            s += 3;
    if (/postdoc|research.associat/.test(t))        s += 3;
    if (/machine.learn|deep.learn/.test(t))         s += 2;
    if (/simulation|modelling|modeling/.test(t))    s += 2;
    if (/mechanical|thermal|fluent/.test(t))        s += 1;
    return s;
  }
  const preloadedJobs = allPreloaded
    .map(j => ({ ...j, _score: scoreJob(j) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 50);

  const jobsJson = JSON.stringify(preloadedJobs.map(j => ({
    title: j.title, company: j.company, location: j.location,
    url: j.url, description: (j.description||"").slice(0, 200)
  })));

  const USER_PROMPT = searchMode
    ? "Search for job opportunities and send me the full report. Be thorough — run all 12 searches."
    : `Top ${preloadedJobs.length} domain-relevant jobs found today (from ${allPreloaded.length} total). Analyze each against the candidate profile, then call send_email_report with the full HTML report.\n\nJOBS JSON:\n${jobsJson}`;

  // Each provider keeps its own message history format
  const messages        = provider === "anthropic" ? [{ role: "user", content: USER_PROMPT }]
                        : provider === "openai"    ? [{ role: "system", content: SYSTEM }, { role: "user", content: USER_PROMPT }]
                        : []; // gemini uses geminiContents below
  const geminiContents  = provider === "gemini"    ? [{ role: "user", parts: [{ text: USER_PROMPT }] }] : [];

  // ─── Helper: render + send the job email from a structured args object ─────
  async function jobSendFromArgs(args, providerUsed, latencyMs) {
    const datePart = new Date().toISOString().slice(0, 10);
    const jobsArr  = Array.isArray(args.jobs) ? args.jobs : [];
    const subject  = args.subject || `🔍 Daily Job Report — ${today}`;
    console.log(`[JobAgent] (${providerUsed}) Rendering HTML for ${jobsArr.length} structured jobs`);
    const fromAddr = context.credentials?.resendFrom || "Job Search Agent <onboarding@resend.dev>";
    const fullHtml = renderJobReportHtml(jobsArr, { title: subject, today, totalFound: allPreloaded.length, footer: "Job search agent" });
    await sendAgentReportEmail({
      resendKey:      context.credentials?.resendApiKey,
      from:           fromAddr,
      to:             toEmail,
      subject,
      fullHtmlBody:   fullHtml,
      title:          subject,
      agentLabel:     "jobs",
      analyzed:       jobsArr.length,
      totalFound:     allPreloaded.length,
      today,
      attachmentName: `job-report-${datePart}.html`,
      extraNote:      `Generated via <b>${providerUsed}</b>${latencyMs ? ` in ${(latencyMs/1000).toFixed(1)} s` : ""} · ${jobsArr.length} jobs with HR contact links, all clickable from the attachment.`,
    });
    return { emailSent: true, providerUsed, jobsReported: jobsArr.length, totalFound: allPreloaded.length };
  }

  const stageAttempts = [];

  // ─── STAGE 1: OAuth/CLI providers (only meaningful when jobs are preloaded) ──
  // In searchMode the agent needs to call linkedin_search multiple times — CLI
  // providers don't natively support tool round-trips, so we skip Stage 1 there.
  if (!searchMode && preloadedJobs.length > 0) {
    const cliChain = node.config?.cliChain || DEFAULT_CLI_CHAIN;
    try {
      const r = await runWithProviderChain({
        systemPrompt:     cliSystemPrompt(SYSTEM, "send_email_report"),
        userPrompt:       USER_PROMPT,
        expectedToolName: "send_email_report",
        chain:            cliChain,
        timeoutMs:        300000,
        logPrefix:        "[JobAgent/CLI]",
      });
      const out = await jobSendFromArgs(r.args, r.providerUsed, r.latencyMs);
      return { success: true, output: { ...out, stage: "cli", provider: "cli", cliAttempts: r.attempts } };
    } catch (cliErr) {
      stageAttempts.push({ stage: "cli", error: String(cliErr.message || cliErr).slice(0, 300), inner: cliErr.attempts });
      console.warn(`[JobAgent] CLI chain failed → trying ${provider} API. ${String(cliErr.message || cliErr).slice(0, 200)}`);
    }
  } else if (searchMode) {
    stageAttempts.push({ stage: "cli", skipped: "searchMode requires multi-tool calls" });
  }

  // ─── STAGE 2: Existing provider-API loop (anthropic / openai / gemini) ─────
  try {

  let emailSent = false;
  let turns     = 0;
  const MAX     = 30;
  let tokIn = 0, tokOut = 0, tokTotal = 0;

  while (turns < MAX && !emailSent) {
    // Respect Gemini free tier rate limit (5 RPM) — wait 13s between turns
    if (provider === "gemini" && turns > 0) await new Promise(r => setTimeout(r, 13000));

    let res;

    if (provider === "gemini") {
      let usedModel = model;
      let data;
      try {
        ({ data, model: usedModel } = await callGeminiWithFallback(geminiKey, model, (m) => ({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents:           geminiContents,
          tools:              GEMINI_TOOLS,
          tool_config:        { function_calling_config: { mode: "ANY" } },
          generationConfig:   { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
        }), 90000));
      } catch (e) {
        throw new Error(`All Gemini models unavailable: ${e.message}`);
      }
      // Wrap into a fake res.ok + res.json() so existing handler works
      res = { ok: true, json: async () => data, _usedModel: usedModel };
    } else if (provider === "anthropic") {
      res = await fetchTimeout("https://api.anthropic.com/v1/messages", {
        method:  "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta":    "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({
          model, max_tokens: 8096,
          system:   [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools:    TOOLS,
          messages,
        }),
      }, 120000);
    } else {
      res = await fetchTimeout("https://api.openai.com/v1/chat/completions", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey}` },
        body: JSON.stringify({ model, max_tokens: 8096, tools: OAI_TOOLS, tool_choice: "auto", messages }),
      }, 120000);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `API error ${res.status}`);
    }

    const response = await res.json();
    turns++;

    // ── Gemini response handling ─────────────────────────────────────────────
    if (provider === "gemini") {
      const candidate  = response.candidates?.[0];
      const modelParts = candidate?.content?.parts || [];
      const finishReason = candidate?.finishReason || "STOP";

      const u = response.usageMetadata || {};
      tokIn    += u.promptTokenCount     || 0;
      tokOut   += u.candidatesTokenCount || 0;
      tokTotal += u.totalTokenCount      || 0;

      // Push model's response to history
      geminiContents.push({ role: "model", parts: modelParts });

      const textSnip = modelParts.filter(p => p.text).map(p => p.text).join(" ").slice(0, 100);
      const fnCalls  = modelParts.filter(p => p.functionCall);
      console.log(`[JobAgent/gemini] Turn ${turns} | finish:${finishReason} | tools:${fnCalls.length} | tokens in:${u.promptTokenCount||0} out:${u.candidatesTokenCount||0} total:${u.totalTokenCount||0} | ${textSnip}`);

      if (!fnCalls.length) break; // no tool calls → done

      // Execute tools and collect responses
      const responseParts = [];
      for (const part of fnCalls) {
        const { name, args } = part.functionCall;
        try {
          const result = await executeTool(name, args);
          if (name === "send_email_report") emailSent = true;
          responseParts.push({ functionResponse: { name, response: { content: JSON.stringify(result) } } });
        } catch (e) {
          console.error(`[JobAgent] Tool error (${name}): ${e.message}`);
          responseParts.push({ functionResponse: { name, response: { error: e.message } } });
        }
      }
      geminiContents.push({ role: "user", parts: responseParts });

    // ── Anthropic response handling ──────────────────────────────────────────
    } else if (provider === "anthropic") {
      messages.push({ role: "assistant", content: response.content });
      const textSnip = response.content.filter(b => b.type === "text").map(b => b.text).join(" ").slice(0, 100);
      console.log(`[JobAgent/${provider}] Turn ${turns} — stop: ${response.stop_reason} | ${textSnip}`);

      if (response.stop_reason === "end_turn") break;
      if (response.stop_reason === "tool_use") {
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          try {
            const result = await executeTool(block.name, block.input);
            if (block.name === "send_email_report") emailSent = true;
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
          } catch (e) {
            console.error(`[JobAgent] Tool error (${block.name}): ${e.message}`);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e.message}`, is_error: true });
          }
        }
        messages.push({ role: "user", content: toolResults });
      }

    // ── OpenAI response handling ─────────────────────────────────────────────
    } else if (provider === "openai") {
      const msg    = response.choices?.[0]?.message;
      const reason = response.choices?.[0]?.finish_reason;
      messages.push(msg);

      const textSnip = (msg?.content || "").slice(0, 100);
      console.log(`[JobAgent/${provider}] Turn ${turns} — finish: ${reason} | ${textSnip}`);

      if (reason === "stop") break;
      if (reason === "tool_calls") {
        const toolResults = [];
        for (const tc of (msg.tool_calls || [])) {
          const name  = tc.function.name;
          const input = JSON.parse(tc.function.arguments || "{}");
          try {
            const result = await executeTool(name, input);
            if (name === "send_email_report") emailSent = true;
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
          } catch (e) {
            console.error(`[JobAgent] Tool error (${name}): ${e.message}`);
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${e.message}` });
          }
        }
        messages.push(...toolResults);
      }
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  const lastText = (
    Array.isArray(lastAssistant?.content)
      ? lastAssistant.content.filter(b => b.type === "text").map(b => b.text).join("\n")
      : lastAssistant?.content || ""
  ).slice(0, 400);

  if (provider === "gemini") console.log(`[JobAgent] TOTAL tokens — in:${tokIn} out:${tokOut} total:${tokTotal} over ${turns} turn(s) | model:${model}`);
  if (emailSent) {
    return {
      success: true,
      output:  { emailSent, agentTurns: turns, provider, model, stage: "api", summary: lastText || "Report sent.",
                 ...(provider === "gemini" ? { tokensIn: tokIn, tokensOut: tokOut, tokensTotal: tokTotal } : {}) },
    };
  }
  throw new Error(`${provider} API loop ended without sending email (turns=${turns})`);

  } catch (apiErr) {
    stageAttempts.push({ stage: "api_" + provider, error: String(apiErr.message || apiErr).slice(0, 300) });
    console.warn(`[JobAgent] ${provider} API failed → trying Ollama. ${String(apiErr.message || apiErr).slice(0, 200)}`);
  }

  // ─── STAGE 3: Ollama (local model) as final backstop ─────────────────────
  if (!searchMode && preloadedJobs.length > 0) {
    try {
      const ollamaModel = node.config?.ollamaModel || context.credentials?.ollamaModel || "qwen2.5:3b";
      const r = await runWithProviderChain({
        systemPrompt:     cliSystemPrompt(SYSTEM, "send_email_report"),
        userPrompt:       USER_PROMPT,
        expectedToolName: "send_email_report",
        chain:            DEFAULT_OLLAMA_CHAIN,
        timeoutMs:        900000,
        providerOptions:  { ollama: { model: ollamaModel } },
        logPrefix:        "[JobAgent/Ollama]",
      });
      const out = await jobSendFromArgs(r.args, `${r.providerUsed} (${ollamaModel})`, r.latencyMs);
      return { success: true, output: { ...out, stage: "ollama", provider: "ollama", allAttempts: stageAttempts.concat(r.attempts) } };
    } catch (ollamaErr) {
      stageAttempts.push({ stage: "ollama", error: String(ollamaErr.message || ollamaErr).slice(0, 300) });
    }
  } else {
    stageAttempts.push({ stage: "ollama", skipped: "searchMode requires multi-tool calls" });
  }

  throw new Error(`All provider stages failed for job agent. Attempts: ${JSON.stringify(stageAttempts)}`);
}

// ─── Job Search (LinkedIn primary + RemoteOK fallback) ────────────────────────
async function runJobSearch(node, context) {
  const jobs = [];
  const seen = new Set();

  function decodeHtml(s) {
    return (s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
  }

  function addJob(job) {
    if (!job.title || job.title.length < 4) return;
    const key = `${job.title.toLowerCase().slice(0, 60)}|${(job.company || "").toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ ...job, id: jobs.length + 1 });
  }

  const LI_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml",
  };

  // ── 1. LinkedIn — India (primary, no auth needed) ─────────────────────────
  const liQueries = [
    { q: "computational fluid dynamics",           loc: "India" },
    { q: "CFD engineer simulation",                loc: "India" },
    { q: "rheology complex fluids scientist",      loc: "India" },
    { q: "heat transfer thermal simulation",       loc: "India" },
    { q: "OpenFOAM Ansys Fluent engineer",         loc: "India" },
    { q: "spray atomization combustion",           loc: "India" },
    { q: "postdoc mechanical engineering fluid",   loc: "India" },
    { q: "machine learning fluid dynamics",        loc: ""      },
    { q: "non-newtonian polymer fluid scientist",  loc: ""      },
    { q: "turbulence simulation research",         loc: "India" },
    { q: "droplet dynamics jet breakup",           loc: "India" },
    { q: "spray cooling thermal management",       loc: ""      },
  ];

  for (const { q, loc } of liQueries) {
    try {
      const params = new URLSearchParams({ keywords: q, f_TPR: "r604800" });
      if (loc) params.set("location", loc);
      const res = await fetchTimeout(`https://www.linkedin.com/jobs/search/?${params}`, { headers: LI_HEADERS }, 8000);
      if (!res.ok) continue;
      const html = await res.text();

      const titles    = [...html.matchAll(/class="base-search-card__title"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g)].map(m => decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()));
      const companies = [...html.matchAll(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g)].map(m => decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()));
      const locs      = [...html.matchAll(/class="job-search-card__location"[^>]*>\s*([\s\S]*?)\s*<\/span>/g)].map(m => decodeHtml(m[1].trim()));
      const urls      = [...html.matchAll(/"(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"&]+)/g)].map(m => m[1]);

      for (let i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        addJob({
          title:       titles[i],
          company:     companies[i] || "Company",
          location:    locs[i]     || loc || "India",
          url:         urls[i]     || `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}`,
          description: `LinkedIn posting. Search: "${q}"`,
          source:      "LinkedIn",
          postedAt:    new Date().toISOString(),
        });
      }
    } catch (e) { console.log(`[JobSearch] LinkedIn "${q}" failed: ${e.message}`); }
  }

  // ── 2. LinkedIn — posted this week, broader global ─────────────────────────
  const liGlobalQueries = [
    { q: "computational fluid dynamics postdoc", loc: "" },
    { q: "rheology research scientist remote",   loc: "" },
    { q: "CFD machine learning engineer",        loc: "" },
  ];
  for (const { q, loc } of liGlobalQueries) {
    try {
      const params = new URLSearchParams({ keywords: q, f_TPR: "r604800", f_WT: "2" }); // remote
      const res = await fetchTimeout(`https://www.linkedin.com/jobs/search/?${params}`, { headers: LI_HEADERS }, 8000);
      if (!res.ok) continue;
      const html = await res.text();
      const titles    = [...html.matchAll(/class="base-search-card__title"[^>]*>\s*([\s\S]*?)\s*<\/h3>/g)].map(m => decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()));
      const companies = [...html.matchAll(/class="base-search-card__subtitle"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/g)].map(m => decodeHtml(m[1].replace(/<[^>]+>/g, "").trim()));
      const locs      = [...html.matchAll(/class="job-search-card__location"[^>]*>\s*([\s\S]*?)\s*<\/span>/g)].map(m => decodeHtml(m[1].trim()));
      const urls      = [...html.matchAll(/"(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"&]+)/g)].map(m => m[1]);
      for (let i = 0; i < titles.length; i++) {
        if (!titles[i]) continue;
        addJob({ title: titles[i], company: companies[i] || "Company", location: locs[i] || "Remote/Global", url: urls[i] || "", description: `LinkedIn Remote. Search: "${q}"`, source: "LinkedIn Remote", postedAt: new Date().toISOString() });
      }
    } catch (e) { console.log(`[JobSearch] LinkedIn global "${q}" failed: ${e.message}`); }
  }

  // ── 3. RemoteOK — strict CFD/fluid domain filter ──────────────────────────
  try {
    const res = await fetchTimeout("https://remoteok.com/api", { headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
    if (res.ok) {
      const data    = await res.json();
      const entries = Array.isArray(data) ? data.slice(1) : [];
      // Only match titles/tags that are strictly in the fluid/thermal/CFD domain
      const strict = /\b(cfd|computational.fluid|fluid.dynamic|rheol|openfoam|ansys.fluent|heat.transfer|thermal.simulation|spray|atomiz|turbulence|non.newtonian|viscoelastic|polymer.fluid|fluid.mechanic|mechanical.simulation)\b/i;
      for (const item of entries) {
        const searchText = `${item.position || ""} ${(item.tags || []).join(" ")} ${(item.description || "").slice(0, 300)}`;
        if (strict.test(searchText)) {
          addJob({
            title:       item.position || "Role",
            company:     item.company  || "Company",
            location:    "Remote",
            url:         item.url || `https://remoteok.com/jobs/${item.id}`,
            description: (item.description || "").replace(/<[^>]+>/g, "").slice(0, 700),
            source:      "RemoteOK",
            postedAt:    item.date || "",
          });
        }
      }
    }
  } catch (e) { console.log(`[JobSearch] RemoteOK failed: ${e.message}`); }

  console.log(`[JobSearch] Collected ${jobs.length} unique positions`);
  return { success: true, output: { jobs, count: jobs.length, fetchedAt: new Date().toISOString() } };
}

// ─── Job Analyzer (Ollama CV matching) ────────────────────────────────────────
async function runJobAnalyzer(node, context) {
  const jobs = context.previousOutput?.jobs || [];
  if (!jobs.length) return { success: true, output: { analyzed: [], count: 0 } };

  const ollamaUrl = (context.credentials?.ollamaUrl || node.config?.ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
  const model     = node.config?.model || "qwen2.5:3b";

  const CV = node.config?.cvSummary || `
CANDIDATE: Amitesh K Chaudhary | PhD Mechanical Engineering, IISc Bangalore (2018–2025)
CURRENT: Research Associate, IISc — Laser diagnostics for jet-in-crossflow combustion studies

EXPERTISE:
- Complex Fluid Rheology: viscoelastic/shear-thinning polymer solutions (Xanthan gum), MCR302 rheometer (steady/dynamic shear), CaBER-DoS extensional measurements
- Spray & Atomization: Rotary atomization, PDIA, shadowgraphy, Sauter mean diameter, droplet size distributions
- Heat & Mass Transfer: Single droplet evaporation (experimental + 1D transient numerical model, Stefan-flow kinetics)
- CFD/Simulation: Ansys Fluent, OpenFOAM, Comsol
- Machine Learning: CNN with TensorFlow & PyTorch, scikit-learn, image processing with OpenCV
- Laser Diagnostics: PIV, PTV, Shadowgraphy, Schlieren, PDIA, High-speed imaging
- Programming: Python (pandas, numpy, matplotlib, plotly, seaborn), MATLAB
- CAD: SolidWorks, CATIA, Solid Edge, AutoDesk Fusion 360
- Other: A/B testing, ANOVA, hypothesis testing, Design of Experiments, Arduino-based sensor systems

PUBLICATIONS: 2 conference (ILASS Asia 2022; ICR Rheology Athens 2023); 3 journal papers in progress (ETFS, JNNFM, IJHMT)
AWARDS: PMRF (Prime Minister's Research Fellow) 2018–2023; Top 2% AIEEE 2011

TARGET: Postdoc / Research / Industry role in CFD, ML applied to fluid dynamics, heat transfer, or complex fluids/rheology
LOCATION PREFERENCE: India preferred; Remote acceptable`;

  const analyzed = [];

  for (let i = 0; i < Math.min(jobs.length, 25); i++) {
    const job = jobs[i];
    const prompt = `You are a career advisor doing CV-to-job matching. Respond ONLY with raw JSON, no markdown fences.

CANDIDATE CV:
${CV}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Source: ${job.source}
Description: ${(job.description || "").slice(0, 900)}

Return exactly this JSON:
{"similarity_pct":<0-100>,"likely_match":"<High|Medium|Low>","selection_probability_pct":<0-100>,"key_requirements":["req1","req2","req3"],"matched_skills":["skill1","skill2","skill3"],"skills_to_develop":["skill1","skill2"],"prep_plan":["step1","step2","step3"],"resources":["resource1","resource2"]}`;

    try {
      const res = await fetchTimeout(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }], options: { temperature: 0.2 } }),
      }, 60000);

      if (res.ok) {
        const data   = await res.json();
        const text   = data.message?.content || "{}";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const analysis  = jsonMatch ? JSON.parse(jsonMatch[0]) : { similarity_pct: 0, likely_match: "Unknown", error: "No JSON in response" };
        analyzed.push({ ...job, analysis });
      } else {
        analyzed.push({ ...job, analysis: { similarity_pct: 0, likely_match: "Unknown", error: `Ollama HTTP ${res.status}` } });
      }
    } catch (e) {
      analyzed.push({ ...job, analysis: { similarity_pct: 0, likely_match: "Unknown", error: e.message } });
    }
  }

  analyzed.sort((a, b) => (b.analysis?.similarity_pct || 0) - (a.analysis?.similarity_pct || 0));
  console.log(`[JobAnalyzer] Analyzed ${analyzed.length} jobs`);
  return { success: true, output: { analyzed, count: analyzed.length, analyzedAt: new Date().toISOString() } };
}

// ─── Email Report (Gmail SMTP via Nodemailer) ──────────────────────────────────
async function runEmailReport(node, context) {
  const nodemailer = require("nodemailer");

  const jobs        = context.previousOutput?.analyzed || [];
  const resendKey   = context.credentials?.resendApiKey;
  const gmailUser   = context.credentials?.gmailUser   || node.config?.gmailUser;
  const gmailPass   = context.credentials?.gmailAppPassword || node.config?.gmailAppPassword;
  const toEmail     = node.config?.to || gmailUser;

  if (!resendKey && (!gmailUser || !gmailPass)) throw new Error("Missing email credentials — set resendApiKey (preferred) or gmailUser+gmailAppPassword via /api/credentials");
  if (!toEmail) throw new Error("Missing 'to' email in emailreport node config");

  const today    = new Date().toLocaleDateString("en-IN", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });
  const high     = jobs.filter(j => j.analysis?.likely_match === "High");
  const medium   = jobs.filter(j => j.analysis?.likely_match === "Medium");
  const low      = jobs.filter(j => j.analysis?.likely_match === "Low");
  const unknown  = jobs.filter(j => !["High","Medium","Low"].includes(j.analysis?.likely_match));

  const matchBg  = { High: "#d4edda", Medium: "#fff3cd", Low: "#f8d7da", Unknown: "#f0f0f0" };

  const jobRow = (job) => {
    const a  = job.analysis || {};
    const bg = matchBg[a.likely_match] || "#f0f0f0";
    return `<tr style="background:${bg}">
      <td style="padding:8px 10px;border:1px solid #ccc;min-width:160px"><a href="${job.url||"#"}" target="_blank" style="color:#0056b3;font-weight:600">${job.title}</a></td>
      <td style="padding:8px 10px;border:1px solid #ccc">${job.company}</td>
      <td style="padding:8px 10px;border:1px solid #ccc">${job.location}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px">${job.source}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;text-align:center;font-weight:700">${a.similarity_pct ?? "?"}%</td>
      <td style="padding:8px 10px;border:1px solid #ccc;text-align:center;font-weight:700">${a.likely_match ?? "?"}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;text-align:center;font-weight:700">${a.selection_probability_pct ?? "?"}%</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px">${(a.key_requirements||[]).map(r=>`• ${r}`).join("<br>")}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px;color:#155724">${(a.matched_skills||[]).map(s=>`✓ ${s}`).join("<br>")}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px;color:#721c24">${(a.skills_to_develop||[]).map(s=>`▸ ${s}`).join("<br>")}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px">${(a.prep_plan||[]).map((s,i)=>`${i+1}. ${s}`).join("<br>")}</td>
      <td style="padding:8px 10px;border:1px solid #ccc;font-size:11px">${(a.resources||[]).join("<br>")}</td>
    </tr>`;
  };

  const tableHeaders = `<tr style="background:#343a40;color:#fff">
    <th style="padding:10px;border:1px solid #555;text-align:left">Job Title</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Company</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Location</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Source</th>
    <th style="padding:10px;border:1px solid #555">Similarity%</th>
    <th style="padding:10px;border:1px solid #555">Match</th>
    <th style="padding:10px;border:1px solid #555">Selection%</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Key Requirements</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">✅ Matched Skills</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">📚 Skills to Develop</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Prep Plan</th>
    <th style="padding:10px;border:1px solid #555;text-align:left">Resources</th>
  </tr>`;

  const section = (title, color, list) => !list.length ? "" : `
    <h3 style="color:${color};margin:24px 0 8px">${title} (${list.length})</h3>
    <div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;font-size:12px;font-family:Arial,sans-serif">
      ${tableHeaders}${list.map(jobRow).join("")}
    </table></div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;max-width:1400px;margin:0 auto;padding:20px;color:#212529">
<h2 style="color:#212529;border-bottom:3px solid #f59e0b;padding-bottom:8px">🔍 Job Opportunities Report — ${today}</h2>
<div style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:8px;padding:16px;margin:16px 0;display:flex;gap:24px;flex-wrap:wrap">
  <span><b>Total found:</b> ${jobs.length}</span>
  <span style="color:#155724"><b>🟢 High match:</b> ${high.length}</span>
  <span style="color:#856404"><b>🟡 Medium match:</b> ${medium.length}</span>
  <span style="color:#721c24"><b>🔴 Low match:</b> ${low.length}</span>
  <br><span style="font-size:11px;color:#6c757d">Keywords: CFD, Fluid Dynamics, Rheology, Heat Transfer, ML | Sources: Indeed India, jobs.ac.uk, RemoteOK, Jina Web Search, EURAXESS, Naukri</span>
</div>
${section("🟢 High Match", "#155724", high)}
${section("🟡 Medium Match", "#856404", medium)}
${section("🔴 Low Match", "#721c24", low)}
${unknown.length ? section("⬜ Unanalyzed", "#6c757d", unknown) : ""}
<p style="color:#6c757d;font-size:11px;margin-top:32px;border-top:1px solid #dee2e6;padding-top:12px">
  Generated by AI Job Search Workflow · ${new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST · Powered by Ollama (qwen2.5:3b)
</p></body></html>`;

  if (resendKey) {
    const fromAddr = context.credentials?.resendFrom || "Job Search Bot <onboarding@resend.dev>";
    const res = await fetchTimeout("https://api.resend.com/emails", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ from: fromAddr, to: [toEmail], subject: `🔍 Job Report ${today} — ${high.length} high matches out of ${jobs.length} found`, html }),
    }, 30000);
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message || `Resend error ${res.status}`); }
  } else {
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: gmailUser, pass: gmailPass } });
    await transporter.sendMail({ from: `"Job Search Bot" <${gmailUser}>`, to: toEmail, subject: `🔍 Job Report ${today} — ${high.length} high matches out of ${jobs.length} found`, html });
  }

  console.log(`[EmailReport] Sent to ${toEmail} — ${jobs.length} jobs, ${high.length} high matches`);
  return { success: true, output: { sent: true, to: toEmail, total: jobs.length, highMatches: high.length, date: today } };
}

// ─── Node Router ──────────────────────────────────────────────────────────────
const HANDLERS = {
  manual:      runManual,
  webhook:     runWebhook,
  schedule:    runSchedule,
  claude:      runClaude,
  slack:       runSlack,
  gmail:       runGmail,
  http:        runHTTP,
  transform:   runTransform,
  ifelse:      runIfElse,
  merge:       runMerge,
  jobsearch:        runJobSearch,
  jobanalyzer:      runJobAnalyzer,
  emailreport:      runEmailReport,
  jobagent:         runJobAgent,
  academicsearch:   runAcademicSearch,
  postdocagent:     runPostdocAgent,
  researchersearch: runResearcherSearch,
  researcheragent:  runResearcherAgent,
};

async function executeNode(node, context) {
  const handler = HANDLERS[node.type];
  if (!handler) return { success: false, error: `Unknown node type: ${node.type}` };
  try {
    return await handler(node, context);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { executeNode };
