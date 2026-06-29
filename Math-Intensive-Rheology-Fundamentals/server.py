#!/usr/bin/env python3
"""
server.py — single-PDF derivation workbench (branch: single-pdf-derivation).

Upload one PDF; the SAME extraction algorithm used for the whole Zotero library
(tools/extract_knowledge.py) runs on it: every display equation anywhere in the
PDF is detected and cropped to a true-to-print image, the mathematics it uses is
classified, and the objective / assumptions / boundary conditions / governing
equations are pulled from the text.

Run:
    pip install flask        # one-time, if needed
    python3 server.py        # serves http://127.0.0.1:8000
"""
import os, sys, shutil, json, re, time, base64, urllib.request, urllib.parse, subprocess, threading
from flask import Flask, request, jsonify, send_from_directory, send_file

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import extract_knowledge as ek   # reuse the exact pipeline
import hashlib

UPLOAD_DIR = os.path.join(HERE, "uploads")
EQ_DIR = os.path.join(UPLOAD_DIR, "eq")
LIB_DIR = os.path.join(UPLOAD_DIR, "library")          # persistent per-PDF store
NOTEBOOKLM_DIR = os.path.join(HERE, "notebooklm_exports")
os.makedirs(EQ_DIR, exist_ok=True)
os.makedirs(LIB_DIR, exist_ok=True)
os.makedirs(NOTEBOOKLM_DIR, exist_ok=True)

app = Flask(__name__, static_folder=HERE, static_url_path="")


@app.after_request
def no_cache_app_shell(resp):
    path = request.path or ""
    if path in ("/", "/upload.html", "/upload.js", "/styles.css", "/sw.js"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp

CONCEPT_META = {
    c[0]: {"id": c[0], "label": c[1], "category": c[2], "icon": c[3], "definition": c[4]}
    for c in ek.CONCEPTS
}

# remembers the most recent upload so /api/explain-step has the page text as context
LAST = {}

# ── background jobs (chapter detection + chapter-scoped vision scans) ─────────
JOBS = {}
JOBS_LOCK = threading.Lock()
BIG_BOOK_PAGES = 120     # PDFs longer than this are treated as books → chapter workflow
SCAN_BUDGET = 60         # max pages per vision-scan selection (the model/agent limit)


def new_job(kind):
    with JOBS_LOCK:
        jid = f"{kind}-{int(time.time() * 1000) % 10_000_000}"
        JOBS[jid] = {"jobId": jid, "kind": kind, "status": "running",
                     "done": 0, "total": 0, "result": None, "error": None, "note": ""}
    return jid


def upd_job(jid, **kw):
    with JOBS_LOCK:
        if jid in JOBS:
            JOBS[jid].update(kw)


def stored_pdf_path(pid, paper=None):
    d, _, src, _ = lib_paths(pid)
    paper = paper or load_paper(pid) or {}
    cand = os.path.join(d, paper.get("pdfFile", "source.pdf"))
    return cand if os.path.exists(cand) else (src if os.path.exists(src) else None)


def render_b64(doc, idx, zoom=2.2):
    import fitz
    pix = doc.load_page(idx).get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    return base64.b64encode(pix.tobytes("png")).decode()


def lib_paths(pid):
    d = os.path.join(LIB_DIR, pid)
    return d, os.path.join(d, "paper.json"), os.path.join(d, "source.pdf"), os.path.join(d, "eq")


def load_paper(pid):
    _, pj, _, _ = lib_paths(pid)
    if os.path.exists(pj):
        with open(pj) as fh:
            return json.load(fh)
    return None


def save_paper(pid, paper):
    d, pj, _, _ = lib_paths(pid)
    os.makedirs(d, exist_ok=True)
    with open(pj, "w") as fh:
        json.dump(paper, fh, ensure_ascii=False)


def safe_slug(s, fallback="paper"):
    s = re.sub(r"\.pdf$", "", s or "", flags=re.I)
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-._").lower()
    return (s or fallback)[:90]


def md_clean(s):
    return re.sub(r"\n{3,}", "\n\n", str(s or "").replace("\r\n", "\n").replace("\r", "\n")).strip()


def md_list(items):
    return "\n".join(f"- {md_clean(x)}" for x in (items or []) if md_clean(x)) or "- Not detected."


def notebooklm_markdown(pid, include_web_refs=True):
    paper = load_paper(pid)
    if not paper:
        return None, None

    pdf_path = stored_pdf_path(pid, paper)
    pages = _page_texts(pdf_path, max_pages=paper.get("pages", 300) or 300) if pdf_path else {}
    title = paper.get("title") or pid
    concepts = paper.get("concepts", []) or []
    sections = paper.get("sections", {}) or {}
    equations = paper.get("equations", []) or []
    vision_eqs = paper.get("visionEqs", []) or []
    flow = paper.get("flow", {}) or {}

    out = [
        f"# {md_clean(title)}",
        "",
        "## NotebookLM Source Summary",
        "",
        f"- Workbench paper id: `{pid}`",
        f"- Sector/domain: {paper.get('sector') or 'Not classified'}",
        f"- Pages: {paper.get('pages') or 'Unknown'}",
        f"- Scanned PDF: {'yes' if paper.get('scanned') else 'no'}",
        f"- Extracted equation crops: {len(equations)}",
        f"- Vision LaTeX equations: {len(vision_eqs)}",
        f"- Math method tags: {len(concepts)}",
    ]

    if paper.get("group"):
        out.append(f"- Library group: {paper.get('group')}")
    if paper.get("added"):
        out.append(f"- Added to workbench: {paper.get('added')}")

    out += ["", "## Detected Mathematical Methods", ""]
    if concepts:
        for c in concepts:
            meta = CONCEPT_META.get(c.get("id"), {})
            label = meta.get("label", c.get("id", "concept"))
            definition = meta.get("definition", "")
            pages_s = ", ".join(str(x) for x in (c.get("pages") or [])[:30])
            suffix = f" Pages: {pages_s}." if pages_s else ""
            out.append(f"- **{label}** ({c.get('count', 0)} hits). {definition}{suffix}".strip())
    else:
        out.append("- No math methods detected yet.")

    out += [
        "",
        "## Objective",
        "",
        md_list(sections.get("objective")),
        "",
        "## Assumptions",
        "",
        md_list(sections.get("assumptions")),
        "",
        "## Boundary And Initial Conditions",
        "",
        md_list(sections.get("boundary")),
        "",
        "## Governing Equations",
        "",
        md_list(sections.get("governing")),
        "",
        "## Vision LaTeX Equations",
        "",
    ]
    if vision_eqs:
        for i, e in enumerate(vision_eqs, 1):
            label = e.get("label") or f"Eq {i}"
            page = e.get("page") or "?"
            latex = md_clean(e.get("latex"))
            out += [f"### {label} | page {page}", "", "$$", latex or "\\text{No LaTeX captured.}", "$$", ""]
    else:
        out.append("No Vision LaTeX equations have been saved for this paper yet.")

    out += ["", "## Extracted Equation Text", ""]
    if equations:
        for e in equations[:500]:
            label = f"Eq {e.get('seq')}" if e.get("seq") is not None else "Equation"
            out += [f"### {label} | page {e.get('page', '?')}", "", md_clean(e.get("text")) or "No text captured.", ""]
        if len(equations) > 500:
            out.append(f"_Truncated after 500 extracted equations out of {len(equations)}._")
    else:
        out.append("No text-layer equations were extracted.")

    out += ["", "## Derivation Dependency Flow", ""]
    nodes = flow.get("nodes") or []
    edges = flow.get("edges") or []
    if nodes and edges:
        for edge in edges[:500]:
            src = nodes[edge.get("from", -1)] if isinstance(edge.get("from"), int) and 0 <= edge.get("from") < len(nodes) else {}
            dst = nodes[edge.get("to", -1)] if isinstance(edge.get("to"), int) and 0 <= edge.get("to") < len(nodes) else {}
            out.append(f"- {src.get('label', edge.get('from'))} -> {dst.get('label', edge.get('to'))}: {md_clean(edge.get('why')) or 'dependency'}")
        if len(edges) > 500:
            out.append(f"_Truncated after 500 flow edges out of {len(edges)}._")
    else:
        out.append("No derivation dependency flow has been built yet.")

    if include_web_refs:
        out += ["", "## Firecrawl Web References", ""]
        refs = firecrawl_search(re.sub(r"\.pdf$", "", title, flags=re.I), 6)
        if refs.get("results"):
            for r in refs["results"]:
                out.append(f"- [{md_clean(r.get('title') or r.get('url'))}]({r.get('url')}) — {md_clean(r.get('desc'))}")
        else:
            out.append(f"- Web references unavailable: {md_clean(refs.get('error') or 'No results returned.')}")

    if pages:
        out += ["", "## Extracted Paper Text", ""]
        total = 0
        max_chars = 1_200_000
        for pg in sorted(pages):
            txt = md_clean(pages.get(pg))
            if not txt:
                continue
            if total + len(txt) > max_chars:
                out.append(f"\n_Text truncated for NotebookLM source size after page {pg - 1}._")
                break
            out += [f"### Page {pg}", "", txt, ""]
            total += len(txt)
    else:
        out += ["", "## Extracted Paper Text", "", "No text layer was available for this PDF, or the PDF was not found locally."]

    filename = f"{pid}-{safe_slug(title)}-notebooklm.md"
    return filename, "\n".join(out).strip() + "\n"


def obsidian_uri(vault_path, note_path):
    vault_name = os.path.basename(os.path.abspath(os.path.expanduser(vault_path)).rstrip(os.sep))
    return "obsidian://open?vault={}&file={}".format(
        urllib.parse.quote(vault_name),
        urllib.parse.quote(note_path.replace(os.sep, "/")),
    )


def safe_rel_path(path):
    parts = []
    for raw in re.split(r"[\\/]+", path or ""):
        clean = re.sub(r"[^A-Za-z0-9 ._()\\-]+", "-", raw).strip(" .")
        if clean and clean not in (".", ".."):
            parts.append(clean[:90])
    return os.path.join(*parts) if parts else ""


def write_obsidian_note(vault_path, folder, title, markdown, create_vault=False):
    vault = os.path.abspath(os.path.expanduser(vault_path or ""))
    if not vault:
        raise ValueError("Obsidian vault path is required.")
    if not os.path.exists(vault):
        if create_vault:
            os.makedirs(os.path.join(vault, ".obsidian"), exist_ok=True)
        else:
            raise ValueError("Vault path does not exist. Enable create-vault or choose an existing vault.")
    if not os.path.isdir(vault):
        raise ValueError("Vault path must be a folder.")

    rel_folder = safe_rel_path(folder or "Derivation Workbench")
    filename = safe_slug(title or "derivation-note", "derivation-note") + ".md"
    out_dir = os.path.abspath(os.path.join(vault, rel_folder))
    if os.path.commonpath([vault, out_dir]) != vault:
        raise ValueError("Export folder must stay inside the vault.")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.abspath(os.path.join(out_dir, filename))
    if os.path.commonpath([vault, out_path]) != vault:
        raise ValueError("Export note must stay inside the vault.")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(md_clean(markdown) + "\n")
    note_rel = os.path.relpath(out_path, vault)
    return out_path, note_rel, obsidian_uri(vault, note_rel)


# ── library groups (ordered names; persisted in LIB_DIR/groups.json) ─────────
def _groups_path():
    return os.path.join(LIB_DIR, "groups.json")


def load_groups():
    p = _groups_path()
    if os.path.exists(p):
        try:
            with open(p) as fh:
                return [g for g in json.load(fh).get("order", []) if isinstance(g, str)]
        except Exception:
            return []
    return []


def save_groups(order):
    seen = set(); clean = [g for g in order if g and not (g in seen or seen.add(g))]   # dedup, keep order
    os.makedirs(LIB_DIR, exist_ok=True)
    with open(_groups_path(), "w") as fh:
        json.dump({"order": clean}, fh, ensure_ascii=False)
    return clean

# ── provider-agnostic LLM layer (no API key needed for Ollama) ───────────────
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama")          # ollama | openrouter | anthropic
LLM_MODEL = os.environ.get("LLM_MODEL", "")                      # empty = auto-detect below (env still wins)
PREFERRED_TEXT_MODELS = ["qwen3.5:9b", "qwen2.5-coder:7b"]       # tried in order; first one installed wins
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
VISION_MODEL = os.environ.get("VISION_MODEL", "")                # auto-detected below if empty


def ollama_tags():
    """Ollama's /api/tags models (each dict carries name + capabilities). Retries once on a
    transient empty/failed body — Ollama occasionally returns nothing while busy, which used
    to empty the model dropdowns."""
    for _ in range(2):
        try:
            with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=8) as r:
                models = json.loads(r.read()).get("models", []) or []
            if models:
                return models
        except Exception:
            pass
        time.sleep(0.3)
    return []


def ollama_models():
    return [m.get("name") for m in ollama_tags() if m.get("name")]


def _model_caps():
    return {m.get("name"): (m.get("capabilities") or []) for m in ollama_tags() if m.get("name")}


def model_has_vision(name):
    return "vision" in _model_caps().get(name, [])


def detect_vision_model():
    """Pick a vision-capable Ollama model, preferring a LOCAL one — cloud models (…-cloud) are
    subject to network 502s. Reads capabilities from /api/tags (no per-model /api/show calls)."""
    caps = _model_caps()
    vis = [n for n, c in caps.items() if "vision" in c]
    local = [n for n in vis if not n.endswith("-cloud")]
    prefer_local = ["qwen2.5vl:7b", "qwen2.5vl:3b", "llama3.2-vision:11b", "minicpm-v:latest", "granite3.2-vision:latest"]
    prefer_cloud = ["gemma4:31b-cloud", "minimax-m3:cloud"]
    for p in prefer_local:                       # a known local vision model first
        if p in local:
            return p
    if local:                                    # any other local vision model
        return local[0]
    for p in prefer_cloud:                        # else fall back to cloud
        if p in vis:
            return p
    return vis[0] if vis else ""


def detect_text_model():
    """Pick a text model: first PREFERRED that's installed, else any local non-vision model."""
    names = ollama_models()
    for p in PREFERRED_TEXT_MODELS:
        if p in names:
            return p
    for n in names:                                              # any non-vision model as a fallback
        if not model_has_vision(n):
            return n
    return names[0] if names else PREFERRED_TEXT_MODELS[0]


def _post_json(url, payload, headers=None, timeout=300):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def llm_chat(messages, model=None, think=None, fmt=None):
    """Returns assistant text. Defaults to local Ollama; switchable via env vars.
    think=False skips a thinking model's reasoning trace (faster). fmt='json' or a JSON
    schema dict forces structured output (Ollama constrains decoding to valid JSON)."""
    model = model or LLM_MODEL
    if LLM_PROVIDER == "ollama":
        payload = {"model": model, "messages": messages, "stream": False,
                   "options": {"temperature": 0.2}}
        if think is not None:
            payload["think"] = think            # Ollama: disable <think> traces on thinking models
        if fmt is not None:
            payload["format"] = fmt             # 'json' or a JSON-schema dict → guaranteed-parseable output
        out = _post_json(f"{OLLAMA_URL}/api/chat", payload)
        return out.get("message", {}).get("content", "").strip()
    if LLM_PROVIDER == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY", "")
        out = _post_json("https://openrouter.ai/api/v1/chat/completions",
                         {"model": model, "messages": messages, "temperature": 0.2},
                         headers={"Authorization": f"Bearer {key}"})
        return out["choices"][0]["message"]["content"].strip()
    if LLM_PROVIDER == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        sys_msg = "\n".join(m["content"] for m in messages if m["role"] == "system")
        usr = [m for m in messages if m["role"] != "system"]
        out = _post_json("https://api.anthropic.com/v1/messages",
                         {"model": model, "max_tokens": 1500, "system": sys_msg, "messages": usr},
                         headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
        return "".join(b.get("text", "") for b in out.get("content", [])).strip()
    raise RuntimeError(f"unknown LLM_PROVIDER {LLM_PROVIDER}")


def llm_vision(image_b64, prompt, model, want_json=True):
    """Send an image + prompt to a vision model. Ollama uses the `images` field."""
    model = model or VISION_MODEL
    if not model:
        raise RuntimeError("no vision model available")
    payload = {"model": model, "stream": False, "options": {"temperature": 0},
               "messages": [{"role": "user", "content": prompt, "images": [image_b64]}]}
    if want_json:
        payload["format"] = "json"
    out = _post_json(f"{OLLAMA_URL}/api/chat", payload, timeout=300)
    return out.get("message", {}).get("content", "").strip()


# pick a vision model now that the helpers above are loaded
if not VISION_MODEL:
    VISION_MODEL = detect_vision_model()
    print(f"vision model: {VISION_MODEL or '(none found — pull e.g. qwen2.5vl:7b)'}")

# pick a text model the same way (env LLM_MODEL still wins if set)
if not LLM_MODEL:
    LLM_MODEL = detect_text_model() if LLM_PROVIDER == "ollama" else PREFERRED_TEXT_MODELS[0]
    print(f"text model: {LLM_MODEL}")


def _strip_fences(s):
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
    return s.strip()


def _first_json(s):
    """Parse JSON from a model reply, tolerating fences and trailing junk (e.g. an extra brace)."""
    s = _strip_fences(s)
    try:
        return json.loads(s)
    except Exception:
        pass
    for op, cl in (("{", "}"), ("[", "]")):              # grab the first balanced object/array
        start = s.find(op)
        if start < 0:
            continue
        depth = 0
        for i in range(start, len(s)):
            if s[i] == op:
                depth += 1
            elif s[i] == cl:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i + 1])
                    except Exception:
                        break
    raise ValueError("no JSON found in model reply")


def _first_latex(data, label=""):
    """Pull ONE equation's LaTeX from whatever shape the model returns:
    {latex}, {equations:[{latex,label}]}, a bare list, or a plain string."""
    if isinstance(data, str):
        return data.strip()
    if isinstance(data, dict):
        if data.get("latex"):
            return str(data["latex"]).strip()
        data = data.get("equations") or []
    if isinstance(data, list):
        norm = [(e if isinstance(e, dict) else {"latex": e}) for e in data
                if (isinstance(e, dict) and e.get("latex")) or (isinstance(e, str) and e.strip())]
        if label:
            for e in norm:
                if (e.get("label") or "").strip() == label:
                    return str(e["latex"]).strip()
        if norm:
            return str(norm[0]["latex"]).strip()
    return ""


VISION_PROMPT = (
    "You are a math OCR engine. Look at this page image and transcribe EVERY displayed "
    "mathematical equation or numbered relation you see, in reading order. Ignore plain "
    "prose, figures, axis labels and tables. Return JSON exactly as "
    "{\"equations\":[{\"latex\":\"<equation in LaTeX, no $ delimiters>\",\"label\":\"<eq number or empty>\"}]}. "
    "Transcribe faithfully; do not invent equations. If there are none, return "
    "{\"equations\":[]}."
)


@app.route("/api/vision-models")
def vision_models():
    caps = _model_caps()
    allm = list(caps.keys())
    vis = [n for n in allm if "vision" in caps.get(n, [])]
    ordered = vis + [n for n in allm if n not in vis]      # vision-capable first, but offer every model
    default = VISION_MODEL or (vis[0] if vis else (ordered[0] if ordered else ""))
    return jsonify({"models": ordered, "vision": vis, "default": default})


@app.route("/api/vision-page", methods=["POST"])
def vision_page():
    """Render one page of the last upload and have a vision model extract its
    equations as LaTeX — works on scanned and broken-font PDFs (text layer ignored)."""
    body = request.get_json(force=True, silent=True) or {}
    page_no = int(body.get("page", 1))
    model = body.get("model") or VISION_MODEL
    path = LAST.get("path")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Upload a PDF first."}), 400
    if not model:
        return jsonify({"error": "No vision model. Pull one, e.g.  ollama pull qwen2.5vl:7b"}), 400
    try:
        import fitz
        doc = fitz.open(path)
        if page_no < 1 or page_no > doc.page_count:
            return jsonify({"error": "page out of range", "pages": doc.page_count}), 400
        pix = doc.load_page(page_no - 1).get_pixmap(matrix=fitz.Matrix(2.2, 2.2))
        img = base64.b64encode(pix.tobytes("png")).decode()
        doc.close()
    except Exception as e:
        return jsonify({"error": f"render failed: {e}"}), 500
    try:
        raw = llm_vision(img, VISION_PROMPT, model)
        data = json.loads(_strip_fences(raw))
        eqs = data.get("equations", data if isinstance(data, list) else [])
        eqs = [{"latex": e.get("latex", "").strip(), "label": (e.get("label") or "").strip()}
               for e in eqs if isinstance(e, dict) and e.get("latex")]
    except Exception as e:
        return jsonify({"error": f"vision parse failed ({model}): {e}", "page": page_no, "equations": []}), 502

    # persist vision LaTeX so it reloads next time the PDF is opened
    pid = LAST.get("pid")
    if pid:
        paper = load_paper(pid)
        if paper is not None:
            ve = [e for e in paper.get("visionEqs", []) if e.get("page") != page_no]
            for e in eqs:
                ve.append({"page": page_no, "latex": e["latex"], "label": e.get("label", "")})
            ve.sort(key=lambda x: x.get("page", 0))
            paper["visionEqs"] = ve
            save_paper(pid, paper)
            LAST["paper"] = paper
    return jsonify({"page": page_no, "equations": eqs, "model": model})


@app.route("/api/vision-eq", methods=["POST"])
def vision_eq():
    """Re-read ONE equation from its page image — repairs a mis-transcribed equation."""
    body = request.get_json(force=True, silent=True) or {}
    page_no = int(body.get("page", 1))
    label = (body.get("label") or "").strip()
    prev = (body.get("latex") or "").strip()
    model = body.get("model") or VISION_MODEL
    path = LAST.get("path")
    if not path or not os.path.exists(path):
        return jsonify({"error": "Open a PDF first."}), 400
    if not model:
        return jsonify({"error": "No vision model available."}), 400
    try:
        import fitz
        doc = fitz.open(path)
        if page_no < 1 or page_no > doc.page_count:
            return jsonify({"error": "page out of range"}), 400
        pix = doc.load_page(page_no - 1).get_pixmap(matrix=fitz.Matrix(2.6, 2.6))   # slightly higher DPI for a clean re-read
        img = base64.b64encode(pix.tobytes("png")).decode()
        doc.close()
    except Exception as e:
        return jsonify({"error": f"render failed: {e}"}), 500
    target = ("the equation labelled \"%s\"" % label) if label else "the single most prominent displayed equation"
    if prev:
        target += " (previously transcribed, with errors, as: %s)" % prev
    prompt = (
        "You are a precise math OCR engine. The page image contains one or more equations. "
        "Find " + target + " and transcribe ONLY that one equation to valid LaTeX: balanced "
        "\\left … \\right, complete brackets/braces, no $ delimiters, nothing truncated. "
        "Return JSON exactly as {\"latex\":\"<LaTeX>\"}."
    )
    try:
        raw = llm_vision(img, prompt, model)
        latex = _first_latex(_first_json(raw), label)
    except Exception as e:
        return jsonify({"error": f"vision re-read failed ({model}): {e}"}), 502
    if not latex:
        return jsonify({"error": "the model couldn't read that equation — try again, or pick another vision model"}), 502
    return jsonify({"page": page_no, "label": label, "latex": latex, "model": model})


@app.route("/api/vision-save", methods=["POST"])
def vision_save():
    """Persist the (possibly hand-edited / re-read) vision equations for the open paper."""
    body = request.get_json(force=True, silent=True) or {}
    eqs = body.get("visionEqs")
    pid = LAST.get("pid")
    if not pid:
        return jsonify({"error": "no open paper"}), 400
    if not isinstance(eqs, list):
        return jsonify({"error": "visionEqs must be a list"}), 400
    paper = load_paper(pid)
    if paper is None:
        return jsonify({"error": "not found"}), 404
    clean = [{"page": int(e.get("page") or 0), "latex": (e.get("latex") or "").strip(),
              "label": (e.get("label") or "").strip()}
             for e in eqs if isinstance(e, dict) and (e.get("latex") or "").strip()]
    paper["visionEqs"] = clean
    save_paper(pid, paper)
    LAST["paper"] = paper
    return jsonify({"ok": True, "count": len(clean)})


@app.route("/api/detect-methods", methods=["POST"])
def detect_methods():
    """Classify the math methods used, from the vision-read equations — for scanned /
    broken-font PDFs whose text layer is empty so regex 'highlight by method' finds nothing."""
    pid = LAST.get("pid")
    paper = LAST.get("paper") or (load_paper(pid) if pid else None)
    if not paper:
        return jsonify({"error": "Open a paper first."}), 400
    veqs = paper.get("visionEqs") or []
    if not veqs:
        return jsonify({"error": "No equations yet — run a Vision LaTeX scan first."}), 400
    sample = veqs[:240]                                   # keep the prompt bounded
    eqlines = "\n".join(f"{i + 1}: {e.get('latex', '')}" for i, e in enumerate(sample))
    # The local model won't reliably emit JSON/ids, but it describes the maths well in prose.
    # So: have it name the methods in standard terminology, then run the SAME proven regex
    # lexicon (ek.CONCEPT_RE) over that prose to map to taxonomy ids.
    try:
        prose = llm_chat([
            {"role": "system", "content": "You are a mathematical-methods analyst. Use precise, conventional textbook terminology."},
            {"role": "user", "content":
                "These LaTeX equations were extracted from a paper:\n" + eqlines +
                "\n\nIn a thorough paragraph, name the standard mathematical methods, models and structures these equations "
                "ACTUALLY use, naming each with its conventional term (e.g. 'partial differential equation', 'finite difference', "
                "'eigenvalue problem', 'constitutive model'). Only name methods genuinely evidenced by these specific equations — "
                "do NOT mention methods that are absent."}],
            think=False)
    except Exception as e:
        return jsonify({"error": f"method detection failed ({LLM_MODEL}): {e}"}), 502
    all_pages = sorted({e.get("page") for e in sample if e.get("page") is not None})[:14]
    concepts = []
    for cid, rx in ek.CONCEPT_RE:                          # proven lexicon, run over the model's prose
        n = len(rx.findall(prose or ""))
        if n >= 1:
            concepts.append({"id": cid, "count": n, "pages": all_pages, "snippet": ""})
    concepts.sort(key=lambda c: c["count"], reverse=True)
    if pid:
        paper["concepts"] = concepts
        save_paper(pid, paper)
        LAST["paper"] = paper
    return jsonify({"concepts": concepts, "source": "vision-llm", "detected": len(concepts)})


# ── chapter detection (vision-read the Contents) ─────────────────────────────
TOC_PROMPT = (
    "This is one scanned page of a book. If it is part of the TABLE OF CONTENTS, return JSON "
    "{\"chapters\":[{\"num\":<int chapter number>,\"name\":\"<chapter title>\",\"printed_start\":<int printed start page>}]} "
    "listing ONLY top-level CHAPTER entries (ignore sub-sections like 1.1 or 4.2, examples, "
    "parts, preface and appendices unless they are numbered chapters). If this page is NOT a "
    "table of contents, return {\"chapters\":[]}."
)
FOLIO_PROMPT = ("This is one scanned page of a book. Return JSON "
                "{\"folio\": <the page number printed on this page as an integer, or null>}.")


def detect_chapters_worker(jid, pid, front_cap):
    try:
        paper = load_paper(pid)
        path = stored_pdf_path(pid, paper)
        if not path:
            upd_job(jid, status="error", error="stored PDF not found"); return
        import fitz
        doc = fitz.open(path); n = doc.page_count
        front = min(front_cap, n)
        upd_job(jid, total=front, note="reading the table of contents")
        chapters = []; toc_found = False; empties = 0
        for i in range(front):
            try:
                raw = llm_vision(render_b64(doc, i, 2.0), TOC_PROMPT, VISION_MODEL)
                chs = (json.loads(_strip_fences(raw)) or {}).get("chapters", [])
            except Exception:
                chs = []
            chs = [c for c in chs if isinstance(c, dict) and c.get("name") and c.get("printed_start") is not None]
            upd_job(jid, done=i + 1)
            if chs:
                toc_found = True; chapters += chs; empties = 0
            elif toc_found:
                empties += 1
                if empties >= 2: break
        seen = set(); clean = []
        for c in chapters:
            try: ps = int(c["printed_start"])
            except Exception: continue
            key = c.get("num", c["name"])
            if key in seen: continue
            seen.add(key)
            clean.append({"num": c.get("num"), "name": str(c["name"])[:80], "printedStart": ps})
        clean.sort(key=lambda c: c["printedStart"])
        if not clean:
            doc.close()
            upd_job(jid, status="done", result={"needsManual": True, "chapters": []}); return
        upd_job(jid, note="calibrating the page offset")
        offs = []
        for idx in sorted({int(n * f) for f in (0.4, 0.55, 0.7)}):
            try:
                fo = (json.loads(_strip_fences(llm_vision(render_b64(doc, idx, 2.2), FOLIO_PROMPT, VISION_MODEL))) or {}).get("folio")
                if isinstance(fo, int) and fo > 0:
                    offs.append((idx + 1) - fo)
            except Exception:
                pass
        offset = sorted(offs)[len(offs) // 2] if offs else 18
        out = []
        for c in clean:
            ps = max(1, min(n, c["printedStart"] + offset))
            out.append({"num": c["num"], "name": c["name"], "printedStart": c["printedStart"],
                        "pdfStart": ps, "pdfEnd": n})
        for k in range(len(out) - 1):
            out[k]["pdfEnd"] = max(out[k]["pdfStart"], out[k + 1]["pdfStart"] - 1)
        doc.close()
        paper["chapters"] = out
        save_paper(pid, paper)
        if LAST.get("pid") == pid: LAST["paper"] = paper
        upd_job(jid, status="done", result={"chapters": out, "offset": offset})
    except Exception as e:
        upd_job(jid, status="error", error=str(e))


@app.route("/api/detect-chapters/<pid>", methods=["POST"])
def detect_chapters(pid):
    paper = load_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    if not VISION_MODEL:
        return jsonify({"error": "No vision model. Pull one, e.g.  ollama pull qwen2.5vl:7b"}), 400
    front_cap = int((request.get_json(force=True, silent=True) or {}).get("front", 30))
    front_cap = max(4, min(front_cap, 40))
    jid = new_job("detect")
    threading.Thread(target=detect_chapters_worker, args=(jid, pid, front_cap), daemon=True).start()
    return jsonify({"jobId": jid})


# ── chapter-scoped vision scan (background) ──────────────────────────────────
def scan_worker(jid, pid, pages, model):
    try:
        paper = load_paper(pid)
        path = stored_pdf_path(pid, paper)
        import fitz
        doc = fitz.open(path)
        chapters = paper.get("chapters", [])
        def chap_of(pg):
            for c in chapters:
                if c.get("pdfStart", 0) <= pg <= c.get("pdfEnd", 0):
                    return c.get("num")
            return None
        pageset = set(pages)
        ve = [e for e in paper.get("visionEqs", []) if e.get("page") not in pageset]
        for k, pg in enumerate(pages):
            if 1 <= pg <= doc.page_count:
                try:
                    eqs = (json.loads(_strip_fences(llm_vision(render_b64(doc, pg - 1, 2.2), VISION_PROMPT, model))) or {}).get("equations", [])
                    for e in eqs:
                        if isinstance(e, dict) and e.get("latex"):
                            ve.append({"page": pg, "latex": e["latex"].strip(),
                                       "label": (e.get("label") or "").strip(), "chapter": chap_of(pg)})
                except Exception as ex:
                    upd_job(jid, note=f"page {pg}: {ex}")
            upd_job(jid, done=k + 1)
            if k % 3 == 0:
                ve.sort(key=lambda x: x.get("page", 0)); paper["visionEqs"] = ve; save_paper(pid, paper)
        doc.close()
        ve.sort(key=lambda x: x.get("page", 0)); paper["visionEqs"] = ve; save_paper(pid, paper)
        if LAST.get("pid") == pid: LAST["paper"] = paper
        upd_job(jid, status="done", result={"eqs": sum(1 for e in ve if e.get("page") in pageset)})
    except Exception as e:
        upd_job(jid, status="error", error=str(e))


@app.route("/api/vision-scan/<pid>", methods=["POST"])
def vision_scan(pid):
    paper = load_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    body = request.get_json(force=True, silent=True) or {}
    model = body.get("model") or VISION_MODEL
    if not model:
        return jsonify({"error": "No vision model. Pull one, e.g.  ollama pull qwen2.5vl:7b"}), 400
    pages = sorted({p for s, e in body.get("ranges", []) for p in range(int(s), int(e) + 1) if p >= 1})
    if not pages:
        return jsonify({"error": "no pages selected"}), 400
    if len(pages) > SCAN_BUDGET and not body.get("force"):
        return jsonify({"error": f"{len(pages)} pages exceeds the {SCAN_BUDGET}-page budget — trim the selection.",
                        "over": True, "pages": len(pages), "budget": SCAN_BUDGET}), 400
    jid = new_job("scan"); upd_job(jid, total=len(pages))
    threading.Thread(target=scan_worker, args=(jid, pid, pages, model), daemon=True).start()
    return jsonify({"jobId": jid, "total": len(pages)})


@app.route("/api/job/<jid>")
def job_status(jid):
    with JOBS_LOCK:
        j = JOBS.get(jid)
    return (jsonify(dict(j)), 200) if j else (jsonify({"error": "unknown job"}), 404)


@app.route("/")
def index():
    return send_file(os.path.join(HERE, "upload.html"))


@app.route("/api/extract", methods=["POST"])
def extract():
    f = request.files.get("pdf")
    if not f or not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Please upload a .pdf file."}), 400

    raw = f.read()
    pid = hashlib.sha1(raw).hexdigest()[:12]               # stable id (same file → same entry)
    libd, _, src, eqd = lib_paths(pid)
    existing = load_paper(pid) or {}
    os.makedirs(libd, exist_ok=True)
    with open(src, "wb") as fh:
        fh.write(raw)
    shutil.rmtree(eqd, ignore_errors=True)
    os.makedirs(eqd, exist_ok=True)
    tmp = src

    # Large book? Skip whole-book OCR + heavy extraction (which choke on hundreds of
    # scanned pages) and register it for the chapter workflow instead.
    try:
        import fitz
        d0 = fitz.open(src)
        page_count = d0.page_count
        sample = "".join(d0.load_page(i).get_text("text") for i in range(min(8, page_count)))
        d0.close()
    except Exception:
        page_count, sample = 0, ""
    if page_count > BIG_BOOK_PAGES:
        paper = {
            "id": pid, "title": f.filename, "pages": page_count,
            "sector": "Book", "scanned": len(sample) < 200, "pdfFile": "source.pdf",
            "bigBook": True, "concepts": [], "equations": [], "sections": {}, "chapters": [],
            "visionEqs": existing.get("visionEqs", []),
            "added": existing.get("added") or time.strftime("%Y-%m-%d %H:%M"),
        }
        save_paper(pid, paper)
        LAST.clear()
        LAST.update(paper=paper, pages={}, path=src, pid=pid)
        return jsonify({"paper": paper, "bigBook": True, "concepts": CONCEPT_META,
                        "vision": {"model": VISION_MODEL, "available": bool(VISION_MODEL)}})

    # whole PDF, no equation cap — we want equations from ANY part of it
    res = ek.extract_pdf(tmp, max_pages=300, max_eqs=400)

    # Only a TRULY scanned PDF (essentially no text layer) is OCR'd. The equation
    # CROPS still come from the real page image, so they look correct, and OCR gives
    # decodable symbols so detection works. (We do NOT OCR text PDFs.)
    scanned = (not res) or len(res[1]) < 120
    pdf_file = "source.pdf"
    if scanned and shutil.which("ocrmypdf"):
        ocr_out = os.path.join(libd, "source_ocr.pdf")
        try:
            subprocess.run(["ocrmypdf", "--force-ocr", "--optimize", "0", tmp, ocr_out],
                           check=True, timeout=1200, capture_output=True)
            r2 = ek.extract_pdf(ocr_out, max_pages=300, max_eqs=400)
            if r2:
                tmp, res, pdf_file = ocr_out, r2, "source_ocr.pdf"
        except Exception:
            pass

    if not res:
        return jsonify({"error": "Could not read this PDF (it may be encrypted or corrupt)."}), 400
    pages_list, fulltext, eqs, page_count, mathfont = res
    if len(fulltext) < 120 and not eqs:
        ocr_hint = ("" if shutil.which("ocrmypdf")
                    else " Install OCR once:  brew install ocrmypdf  — then re-upload.")
        return jsonify({"error": "This PDF has no readable text or equations (it looks scanned"
                                 + (" and OCR could not recover it)." if shutil.which("ocrmypdf")
                                    else ")." ) + ocr_hint}), 400

    concepts = ek.find_concepts(pages_list, fulltext)
    sections = ek.extract_sections(fulltext)
    sector = ek.classify_sector(f.filename, fulltext)
    ek.render_equations(tmp, eqs, eqd, "u", max_imgs=400)
    for e in eqs:                       # serve crops per-PDF from the library
        if e.get("img"):
            e["img"] = f"/api/eqimg/{pid}/" + os.path.basename(e["img"])

    paper = {
        "id": pid, "title": f.filename, "pages": page_count, "sector": sector,
        "mathFont": mathfont, "scanned": bool(scanned), "pdfFile": pdf_file,
        "concepts": [{"id": c["id"], "count": c["count"], "pages": c["pages"]} for c in concepts],
        "equations": eqs, "sections": sections,
        "visionEqs": existing.get("visionEqs", []),     # keep any vision LaTeX from before
        "added": existing.get("added") or time.strftime("%Y-%m-%d %H:%M"),
    }
    save_paper(pid, paper)
    LAST.clear()
    LAST.update(paper=paper, pages={pg: t for pg, t in pages_list}, path=tmp, pid=pid)
    return jsonify({"paper": paper, "concepts": CONCEPT_META,
                    "llm": {"provider": LLM_PROVIDER, "model": LLM_MODEL},
                    "vision": {"model": VISION_MODEL, "available": bool(VISION_MODEL)}})


def _page_texts(pdf_path, max_pages=300):
    import fitz
    out = {}
    try:
        doc = fitz.open(pdf_path)
        for i in range(min(doc.page_count, max_pages)):
            out[i + 1] = doc.load_page(i).get_text("text")
        doc.close()
    except Exception:
        pass
    return out


@app.route("/api/library")
def library():
    items = []
    for pid in os.listdir(LIB_DIR):
        p = load_paper(pid)
        if not p:
            continue
        items.append({"id": pid, "title": p.get("title"), "pages": p.get("pages"),
                      "sector": p.get("sector"), "scanned": p.get("scanned"),
                      "group": p.get("group", ""),
                      "nEq": len(p.get("equations", [])), "nVision": len(p.get("visionEqs", [])),
                      "nConcepts": len(p.get("concepts", [])), "added": p.get("added", "")})
    items.sort(key=lambda x: x.get("added", ""), reverse=True)
    return jsonify({"papers": items, "concepts": CONCEPT_META, "groups": load_groups(),
                    "llm": {"provider": LLM_PROVIDER, "model": LLM_MODEL},
                    "vision": {"model": VISION_MODEL, "available": bool(VISION_MODEL)}})


@app.route("/api/library/<pid>")
def library_get(pid):
    paper = load_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    _, _, src, _ = lib_paths(pid)
    pdf_path = os.path.join(LIB_DIR, pid, paper.get("pdfFile", "source.pdf"))
    if not os.path.exists(pdf_path):
        pdf_path = src
    LAST.clear()
    LAST.update(paper=paper, pages=_page_texts(pdf_path), path=pdf_path, pid=pid)
    return jsonify({"paper": paper, "concepts": CONCEPT_META,
                    "llm": {"provider": LLM_PROVIDER, "model": LLM_MODEL},
                    "vision": {"model": VISION_MODEL, "available": bool(VISION_MODEL)}})


@app.route("/api/library/<pid>", methods=["DELETE"])
def library_del(pid):
    shutil.rmtree(os.path.join(LIB_DIR, pid), ignore_errors=True)
    return jsonify({"ok": True})


@app.route("/api/library/<pid>/group", methods=["POST"])
def set_paper_group(pid):
    body = request.get_json(force=True, silent=True) or {}
    group = (body.get("group") or "").strip()
    p = load_paper(pid)
    if not p:
        return jsonify({"error": "not found"}), 404
    p["group"] = group
    save_paper(pid, p)
    if group and group not in load_groups():       # auto-register a brand-new group name
        save_groups(load_groups() + [group])
    return jsonify({"ok": True, "group": group, "groups": load_groups()})


@app.route("/api/notebooklm-export/<pid>", methods=["POST"])
def notebooklm_export(pid):
    body = request.get_json(force=True, silent=True) or {}
    filename, md = notebooklm_markdown(pid, include_web_refs=body.get("webRefs", True))
    if not filename:
        return jsonify({"error": "not found"}), 404
    os.makedirs(NOTEBOOKLM_DIR, exist_ok=True)
    out_path = os.path.join(NOTEBOOKLM_DIR, filename)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    return jsonify({
        "ok": True,
        "filename": filename,
        "path": out_path,
        "downloadUrl": f"/api/notebooklm-export/{pid}/download/{urllib.parse.quote(filename)}",
    })


@app.route("/api/notebooklm-export/<pid>/download/<path:filename>")
def notebooklm_export_download(pid, filename):
    expected = f"{pid}-"
    if not filename.startswith(expected) or "/" in filename or "\\" in filename:
        return jsonify({"error": "invalid export filename"}), 400
    return send_from_directory(NOTEBOOKLM_DIR, filename, mimetype="text/markdown", as_attachment=True)


@app.route("/api/obsidian/export", methods=["POST"])
def obsidian_export():
    body = request.get_json(force=True, silent=True) or {}
    try:
        out_path, note_rel, uri = write_obsidian_note(
            body.get("vaultPath"),
            body.get("folder"),
            body.get("title"),
            body.get("markdown") or "",
            bool(body.get("createVault")),
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "path": out_path, "notePath": note_rel, "obsidianUri": uri})


@app.route("/api/groups", methods=["POST"])
def groups_manage():
    body = request.get_json(force=True, silent=True) or {}
    action = (body.get("action") or "").strip()
    name = (body.get("name") or "").strip()
    order = load_groups()
    if action == "create":
        if not name:
            return jsonify({"error": "empty name"}), 400
        order = save_groups(order + [name])
    elif action == "rename":
        new = (body.get("newName") or "").strip()
        if not name or not new:
            return jsonify({"error": "name and newName required"}), 400
        order = save_groups([new if g == name else g for g in order] + [new])
        for pid in os.listdir(LIB_DIR):                 # cascade to member papers
            p = load_paper(pid)
            if p and (p.get("group") or "") == name:
                p["group"] = new; save_paper(pid, p)
    elif action == "delete":
        order = save_groups([g for g in order if g != name])
        for pid in os.listdir(LIB_DIR):                 # un-group its papers
            p = load_paper(pid)
            if p and (p.get("group") or "") == name:
                p["group"] = ""; save_paper(pid, p)
    else:
        return jsonify({"error": "unknown action"}), 400
    return jsonify({"ok": True, "groups": order})


@app.route("/api/pdf/<pid>")
def serve_pdf(pid):
    paper = load_paper(pid) or {}
    fname = paper.get("pdfFile", "source.pdf")
    d = os.path.join(LIB_DIR, pid)
    if not os.path.exists(os.path.join(d, fname)):
        fname = "source.pdf"
    return send_from_directory(d, fname, mimetype="application/pdf")


@app.route("/api/eqimg/<pid>/<path:fn>")
def serve_eqimg(pid, fn):
    return send_from_directory(os.path.join(LIB_DIR, pid, "eq"), fn)


@app.route("/api/graph")
def graph():
    """Cross-PDF concept graph: which mathematical concepts appear in which PDFs."""
    papers, nodes = [], {}
    for pid in os.listdir(LIB_DIR):
        p = load_paper(pid)
        if not p:
            continue
        papers.append({"id": pid, "title": p.get("title"), "scanned": p.get("scanned")})
        for c in p.get("concepts", []):
            n = nodes.setdefault(c["id"], {"id": c["id"], "papers": []})
            n["papers"].append({"pid": pid, "pages": c.get("pages", []), "count": c.get("count", 1)})
    out = []
    for cid, n in nodes.items():
        meta = CONCEPT_META.get(cid, {})
        out.append({"id": cid, "label": meta.get("label", cid), "category": meta.get("category", ""),
                    "icon": meta.get("icon", "•"), "definition": meta.get("definition", ""),
                    "papers": n["papers"], "paperCount": len(n["papers"])})
    out.sort(key=lambda x: -x["paperCount"])
    return jsonify({"papers": papers, "concepts": out})


@app.route("/api/models")
def models():
    """List locally-available Ollama models so the UI can offer a picker."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as r:
            tags = json.loads(r.read().decode())
        names = [m.get("name") for m in tags.get("models", [])]
        return jsonify({"provider": LLM_PROVIDER, "default": LLM_MODEL, "models": names})
    except Exception as e:
        return jsonify({"provider": LLM_PROVIDER, "default": LLM_MODEL, "models": [], "error": str(e)})


@app.route("/api/explain-step", methods=["POST"])
def explain_step():
    """Fill in the derivation between two consecutive equations of the last upload."""
    body = request.get_json(force=True, silent=True) or {}
    from_seq = int(body.get("fromSeq", 0))
    model = body.get("model") or LLM_MODEL
    paper = LAST.get("paper") or {}

    # Vision mode passes clean LaTeX directly; otherwise use the extracted equations.
    if body.get("fromText") and body.get("toText"):
        cur = {"seq": body.get("fromLabel") or from_seq, "page": body.get("fromPage", 0),
               "text": body["fromText"]}
        nxt = {"seq": body.get("toLabel") or (from_seq + 1), "page": body.get("toPage", 0),
               "text": body["toText"]}
    else:
        eqs = paper.get("equations", [])
        cur = next((e for e in eqs if e["seq"] == from_seq), None)
        nxt = next((e for e in eqs if e["seq"] == from_seq + 1), None)
        if not cur or not nxt:
            return jsonify({"error": "No following equation to derive toward."}), 400

    # the paper's own words spanning the two equations = the derivation narrative
    pages = LAST.get("pages", {})
    p0, p1 = cur.get("page", 0) or 0, nxt.get("page", 0) or 0
    ctx = ek.squeeze("\n".join(pages.get(pg, "") for pg in range(p0, p1 + 1)))[:5000] if p0 else ""
    assumptions = "; ".join(paper.get("sections", {}).get("assumptions", [])[:4])

    system = (
        "You are a rigorous mathematical-physics tutor. You are given two consecutive "
        "equations from a research paper plus the surrounding text. Reconstruct the FULL "
        "derivation that turns the first equation into the second: show every intermediate "
        "algebraic step, name each manipulation (substitution, integration, non-dimensionalization, "
        "linearization, Taylor expansion, etc.), and state any assumption or boundary condition used. "
        "Be concrete; do not just restate the equations. Write mathematics in LaTeX using \\( \\) for "
        "inline and \\[ \\] for displayed equations. If a step is genuinely ambiguous from the text, "
        "say so and give the most standard route."
    )
    user = (
        f"Paper: {paper.get('title')}\nField: {paper.get('sector')}\n"
        f"Known assumptions: {assumptions or 'n/a'}\n\n"
        f"START — Equation {cur['seq']} (p{cur['page']}):\n{cur['text']}\n\n"
        f"END — Equation {nxt['seq']} (p{nxt['page']}):\n{nxt['text']}\n\n"
        f"Surrounding text from the paper between them:\n\"\"\"\n{ctx}\n\"\"\"\n\n"
        f"Explain, step by step, how to get from Equation {cur['seq']} to Equation {nxt['seq']}."
    )
    try:
        text = llm_chat([{"role": "system", "content": system},
                         {"role": "user", "content": user}], model=model)
    except Exception as e:
        return jsonify({"error": f"LLM call failed ({LLM_PROVIDER}/{model}): {e}"}), 502
    return jsonify({"explanation": text, "model": model,
                    "from": cur["seq"], "to": nxt["seq"]})


@app.route("/api/explain-substep", methods=["POST"])
def explain_substep():
    """Drill into ONE step of an A→B derivation: justify/derive that step in detail."""
    body = request.get_json(force=True, silent=True) or {}
    step = (body.get("step") or "").strip()
    if not step:
        return jsonify({"error": "No step to explain."}), 400
    model = body.get("model") or LLM_MODEL
    fl, tl = body.get("fromLabel") or "Eq A", body.get("toLabel") or "Eq B"
    ft, tt = body.get("fromText") or "", body.get("toText") or ""
    system = (
        "You are a rigorous mathematical-physics tutor. A student is reading a derivation that "
        "goes from one equation to another and wants a MUCH more detailed justification of ONE "
        "specific step in it. Explain WHY that step is valid and show the full intermediate "
        "algebra: every identity, rule, substitution, expansion or limit it relies on, step by "
        "step, with no skipped manipulation. Stay focused on that one step. Write mathematics in "
        "LaTeX using \\( \\) inline and \\[ \\] displayed."
    )
    user = (
        f"The overall derivation goes from {fl}:\n{ft}\n\nto {tl}:\n{tt}\n\n"
        f"The single step the student wants explained in full detail:\n\"\"\"\n{step}\n\"\"\"\n\n"
        f"Give the detailed sub-derivation and justification of THIS step only."
    )
    try:
        text = llm_chat([{"role": "system", "content": system},
                         {"role": "user", "content": user}], model=model)
    except Exception as e:
        return jsonify({"error": f"LLM call failed ({LLM_PROVIDER}/{model}): {e}"}), 502
    return jsonify({"explanation": text, "model": model})


def _parse_json(raw):
    raw = _strip_fences(raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


@app.route("/api/eqflow/<pid>", methods=["POST"])
def eqflow(pid):
    """Flow chart of equations connected by their DERIVATION dependencies (not just
    sequence). Built from the clean Vision LaTeX equations: an LLM reasons over the
    actual math (which result/quantity from one equation feeds another) plus textual
    references, and returns dependency edges by integer index. Cached in paper.json."""
    body = request.get_json(force=True, silent=True) or {}
    model = body.get("model") or LLM_MODEL
    rebuild = bool(body.get("rebuild"))
    paper = load_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    veqs = paper.get("visionEqs", [])
    if len(veqs) < 2:
        return jsonify({"error": "Run a Vision scan first — the flow chart links the clean LaTeX "
                                 "equations from the Vision tab.", "needVision": True}), 400
    if paper.get("flow") and not rebuild and paper["flow"].get("src") == "symbolic":
        return jsonify({"flow": paper["flow"], "cached": True})

    # deterministic: connect each equation to the equations that define the symbols it
    # uses (which derived quantity feeds which) — content-based and scales to hundreds.
    flow = ek.build_eq_flow_symbolic(veqs)
    paper["flow"] = flow
    save_paper(pid, paper)
    return jsonify({"flow": flow, "edges": len(flow["edges"])})


@app.route("/uploads/eq/<path:fn>")
def eq_img(fn):
    return send_from_directory(EQ_DIR, fn)


# ── web references via the Firecrawl CLI ─────────────────────────────────────
def firecrawl_bin():
    """Locate the firecrawl CLI. The server's PATH (non-interactive) usually misses npm/nvm
    bin dirs, so search common install locations too — incl. nvm-managed node versions."""
    import glob
    cand = [shutil.which("firecrawl")]
    cand += sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/firecrawl")), reverse=True)
    cand += [os.path.expanduser("~/.npm-global/bin/firecrawl"),
             "/opt/homebrew/bin/firecrawl", "/usr/local/bin/firecrawl"]
    for c in cand:
        if c and os.path.exists(c):
            return c
    return os.path.expanduser("~/.npm-global/bin/firecrawl")    # nonexistent → triggers the install hint


def firecrawl_search(query, limit=6):
    fc = firecrawl_bin()
    if not os.path.exists(fc):
        return {"error": "Firecrawl CLI not installed (npm i -g firecrawl-cli)."}
    # firecrawl's `#!/usr/bin/env node` shebang needs node on PATH — node lives in the same
    # bin dir, so prepend it (the server's own PATH usually lacks it).
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(fc) + os.pathsep + env.get("PATH", "")
    try:
        r = subprocess.run([fc, "search", query, "--categories", "research,pdf",
                            "--limit", str(limit), "--json"],
                           capture_output=True, text=True, timeout=120,
                           stdin=subprocess.DEVNULL, env=env)   # never block on the auth prompt
    except subprocess.TimeoutExpired:
        return {"error": "Firecrawl search timed out."}
    blob = ((r.stdout or "") + (r.stderr or "")).lower()
    if any(s in blob for s in ("api key", "suspicious", "sign up for a free")):
        return {"needsAuth": True,
                "error": "Firecrawl needs an API key here — get a free key at firecrawl.dev, then "
                         "set FIRECRAWL_API_KEY in the server's environment (or run: firecrawl login)."}
    if any(s in blob for s in ("not authenticated", "firecrawl login", "login with browser",
                               "authenticate with your firecrawl", "to get started, authenticate")):
        return {"needsAuth": True,
                "error": "Firecrawl is not authenticated. In a terminal run:  firecrawl login --browser"}
    try:
        data = json.loads(r.stdout.strip())
    except Exception:
        return {"error": (r.stderr or r.stdout or "no output from Firecrawl")[:300]}
    d = data.get("data", data)
    web = d.get("web") if isinstance(d, dict) else (d if isinstance(d, list) else [])
    results = [{"title": it.get("title") or it.get("url"),
                "url": it.get("url"),
                "desc": (it.get("description") or it.get("snippet") or "")[:240]}
               for it in (web or [])[:limit] if it.get("url")]
    return {"results": results}


@app.route("/api/web-references", methods=["POST"])
def web_references():
    body = request.get_json(force=True, silent=True) or {}
    query = (body.get("query") or "").strip()
    if not query:
        query = re.sub(r"\.pdf$", "", (LAST.get("paper") or {}).get("title", ""), flags=re.I)
    if not query:
        return jsonify({"error": "No query — upload a PDF or type a query."}), 400
    res = firecrawl_search(query, max(1, min(int(body.get("limit", 6)), 20)))
    code = 200 if "results" in res else (401 if res.get("needsAuth") else 502)
    return jsonify(res), code


# ── per-topic explainer: brief LLM blurb + curated "start here" refs + live web refs ─────
def _scholar(q):
    return "https://scholar.google.com/scholar?q=" + urllib.parse.quote(q)

# Canonical "where to start reading" works per math-method concept id. A bare string becomes
# a Google Scholar search link (always resolves to the real work, never a fabricated DOI);
# a (title, url) tuple uses that exact link (reserved for DOIs we're confident in).
CURATED_REFS = {
  "eigen":        ["Gilbert Strang — Introduction to Linear Algebra", "Trefethen & Bau — Numerical Linear Algebra"],
  "matrix":       ["Gilbert Strang — Introduction to Linear Algebra", "Golub & Van Loan — Matrix Computations"],
  "tensor":       ["Gurtin, Fried & Anand — The Mechanics and Thermodynamics of Continua", "Bird, Armstrong & Hassager — Dynamics of Polymeric Liquids, Vol. 1"],
  "normalmodes":  [("Rouse 1953 — Theory of linear viscoelastic properties of dilute polymer solutions", "https://doi.org/10.1063/1.1699180"),
                   ("Zimm 1956 — Dynamics of polymer molecules in dilute solution", "https://doi.org/10.1063/1.1742462")],
  "ode":          ["Boyce & DiPrima — Elementary Differential Equations", "Strogatz — Nonlinear Dynamics and Chaos"],
  "pde":          ["L. C. Evans — Partial Differential Equations", "Strauss — Partial Differential Equations: An Introduction"],
  "fourier":      ["Bracewell — The Fourier Transform and Its Applications", "Stein & Shakarchi — Fourier Analysis: An Introduction"],
  "laplace":      ["Schiff — The Laplace Transform: Theory and Applications", "Arfken & Weber — Mathematical Methods for Physicists"],
  "perturbation": ["Bender & Orszag — Advanced Mathematical Methods for Scientists and Engineers", "E. J. Hinch — Perturbation Methods"],
  "variational":  ["Gelfand & Fomin — Calculus of Variations", "Lanczos — The Variational Principles of Mechanics"],
  "gaussian":     ["Rubinstein & Colby — Polymer Physics (OUP, 2003)", "Doi & Edwards — The Theory of Polymer Dynamics"],
  "stochastic":   ["Gardiner — Handbook of Stochastic Methods", "Risken — The Fokker–Planck Equation"],
  "fokker":       ["Risken — The Fokker–Planck Equation", "Gardiner — Handbook of Stochastic Methods"],
  "randomwalk":   ["de Gennes — Scaling Concepts in Polymer Physics", "Rubinstein & Colby — Polymer Physics"],
  "correlation":  ["Hansen & McDonald — Theory of Simple Liquids", "Berne & Pecora — Dynamic Light Scattering"],
  "montecarlo":   ["Frenkel & Smit — Understanding Molecular Simulation", "Landau & Binder — A Guide to Monte Carlo Simulations in Statistical Physics"],
  "navierstokes": ["G. K. Batchelor — An Introduction to Fluid Dynamics", "Bird, Armstrong & Hassager — Dynamics of Polymeric Liquids, Vol. 1"],
  "constitutive": ["Bird, Armstrong & Hassager — Dynamics of Polymeric Liquids", "R. G. Larson — Constitutive Equations for Polymer Melts and Solutions"],
  "conservation": ["Bird, Stewart & Lightfoot — Transport Phenomena", "G. K. Batchelor — An Introduction to Fluid Dynamics"],
  "dimensionless":["Barenblatt — Scaling, Self-Similarity, and Intermediate Asymptotics", ("McKinley 2005 — Visco-elasto-capillary thinning and break-up of complex fluids", "https://scholar.google.com/scholar?q=McKinley+2005+visco-elasto-capillary+thinning")],
  "instability":  ["Chandrasekhar — Hydrodynamic and Hydromagnetic Stability", "Eggers & Villermaux 2008 — Physics of liquid jets"],
  "scaling":      ["de Gennes — Scaling Concepts in Polymer Physics", "Barenblatt — Scaling, Self-Similarity, and Intermediate Asymptotics"],
  "rouse":        [("Rouse 1953", "https://doi.org/10.1063/1.1699180"), ("Zimm 1956", "https://doi.org/10.1063/1.1742462"), "Rubinstein & Colby — Polymer Physics"],
  "reptation":    [("Doi & Edwards 1978 — Dynamics of concentrated polymer systems", "https://doi.org/10.1039/F29787401789"),
                   ("McLeish 2002 — Tube theory of entangled polymer dynamics", "https://doi.org/10.1080/00018730210153216"),
                   ("Likhtman & McLeish 2002", "https://doi.org/10.1021/ma0200219")],
  "relaxation":   ["J. D. Ferry — Viscoelastic Properties of Polymers", ("Del Giudice et al. 2017", "https://doi.org/10.1122/1.4975933")],
  "chainstats":   ["Rubinstein & Colby — Polymer Physics", "Flory — Statistical Mechanics of Chain Molecules"],
  "elastocapillary": [("McKinley 2005 — Visco-elasto-capillary thinning and break-up of complex fluids", "https://scholar.google.com/scholar?q=McKinley+2005+visco-elasto-capillary+thinning"),
                      "Entov & Hinch 1997 — Effect of a spectrum of relaxation times on capillary thinning",
                      ("Dinic et al. 2015", "https://doi.org/10.1021/acsmacrolett.5b00393")],
  "fem":          ["T. J. R. Hughes — The Finite Element Method", "Mazumder — Numerical Methods for Partial Differential Equations"],
  "neuralnet":    [("Raissi, Perdikaris & Karniadakis 2019 — Physics-informed neural networks", "https://doi.org/10.1016/j.jcp.2018.10.045"),
                   "Goodfellow, Bengio & Courville — Deep Learning"],
  "optimization": ["Nocedal & Wright — Numerical Optimization", "Boyd & Vandenberghe — Convex Optimization"],
}


@app.route("/api/topic", methods=["POST"])
def topic():
    """Fast part: curated 'start here' refs + best-effort live web refs (no LLM, returns instantly)."""
    body = request.get_json(force=True, silent=True) or {}
    cid = (body.get("id") or "").strip()
    label = (body.get("label") or cid).strip()
    if not cid:
        return jsonify({"error": "no concept id"}), 400
    curated = []
    for ref in CURATED_REFS.get(cid, []):
        title, url = (ref if isinstance(ref, (list, tuple)) else (ref, ""))
        curated.append({"title": title, "url": url or _scholar(title)})
    web = firecrawl_search(f"{label} review tutorial", 5)   # best-effort; {results} or {error/needsAuth}
    return jsonify({"id": cid, "label": label, "curated": curated, "web": web})


@app.route("/api/explain-topic", methods=["POST"])
def explain_topic():
    """Slow part: a brief LLM explanation of the topic (fetched separately so refs aren't blocked)."""
    body = request.get_json(force=True, silent=True) or {}
    label = (body.get("label") or body.get("id") or "").strip()
    if not label:
        return jsonify({"error": "no topic"}), 400
    try:
        explanation = llm_chat([
            {"role": "system", "content": "You are a concise applied-math and physics tutor. Reply in 3–4 sentences of plain prose — no markdown, headings or lists."},
            {"role": "user", "content": f"Explain the topic \"{label}\" as it is used in mathematical-physics / rheology research: what it is, why it matters, and the first key idea to grasp."},
        ], think=False)
        return jsonify({"explanation": explanation})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    import socket
    def _lan_ip():
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close(); return ip
        except Exception:
            return None
    ip = _lan_ip()
    print("Derivation workbench:")
    print("  • on this Mac:               http://127.0.0.1:8000")
    if ip:
        print(f"  • on your phone (same Wi-Fi): http://{ip}:8000")
    print("  (binds to the local network — keep to a trusted Wi-Fi; there is no auth.)")
    # 0.0.0.0 = listen on all interfaces so phones/tablets on the same network can connect
    app.run(host="0.0.0.0", port=8000, debug=False, threaded=True)
