#!/usr/bin/env python3
"""
extract_knowledge.py — read the real Zotero PDF library and build a
content-grounded knowledge base: which mathematical concepts/methods each
paper actually uses (with evidence snippets + page numbers) and the cleanly
extractable equations. Output feeds the concept knowledge graph in the app.

Usage:
  python3 tools/extract_knowledge.py [--limit N] [--pages P] [--zdb PATH]

Output:
  data/knowledge.json          (full structured data)
  data/knowledge.js            (window.RHEO_KNOWLEDGE = {...} for file:// loads)
"""
import os, re, sys, json, time, argparse, html, shutil

try:
    import fitz  # PyMuPDF
except Exception as e:
    print("PyMuPDF (fitz) is required:", e); sys.exit(1)

DEFAULT_ZDB = "/Users/amiteshkumar/Library/CloudStorage/GoogleDrive-amitesh18iisc@gmail.com/My Drive/Zotero_DB"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, "data")

# ── concept lexicon ──────────────────────────────────────────────────────────
# id, label, category, icon (emoji), one-line definition, regex patterns.
# Patterns are matched case-insensitively with word boundaries where sensible.
CONCEPTS = [
  # Linear algebra
  ("eigen", "Eigenvalue problem", "Linear algebra", "λ",
   "Decomposing a linear operator into eigenvalues/eigenvectors; underlies normal modes.",
   [r"eigen ?(value|vector|mode|function|frequenc)", r"\bspectral decomposition\b"]),
  ("matrix", "Matrices & linear systems", "Linear algebra", "▦",
   "Representing linear maps and solving coupled linear systems.",
   [r"\bmatri(x|ces)\b", r"\blinear system", r"\binvert(ible|ing)? matrix"]),
  ("tensor", "Tensor calculus", "Linear algebra", "⊗",
   "Multilinear objects (stress, strain, deformation) and their invariants.",
   [r"\btensor", r"stress tensor", r"strain (rate )?tensor", r"deformation gradient"]),
  ("normalmodes", "Normal-mode analysis", "Linear algebra", "〰",
   "Diagonalizing coupled dynamics into independent modes (Rouse/Zimm modes).",
   [r"normal mode", r"rouse mode", r"mode (number|index|amplitude)"]),
  # Calculus / analysis
  ("ode", "Differential equations (ODE)", "Calculus & analysis", "∂",
   "Equations relating a function to its derivatives in one variable.",
   [r"\bordinary differential equation", r"\bODE\b", r"equation of motion"]),
  ("pde", "Partial differential equations", "Calculus & analysis", "∇",
   "Governing equations in space and time (diffusion, Navier–Stokes, heat).",
   [r"\bpartial differential equation", r"\bPDE(s)?\b", r"diffusion equation", r"heat equation"]),
  ("fourier", "Fourier analysis", "Calculus & analysis", "∿",
   "Decomposing signals/fields into frequency or wavevector components.",
   [r"fourier (transform|series|mode|space|analysis)", r"\bwavevector", r"\bwave ?number"]),
  ("laplace", "Laplace / integral transforms", "Calculus & analysis", "ℒ",
   "Transform methods that turn differential equations into algebraic ones.",
   [r"laplace transform", r"integral transform", r"\bconvolution\b"]),
  ("perturbation", "Perturbation & asymptotics", "Calculus & analysis", "ε",
   "Approximating solutions via small-parameter expansions and asymptotic limits.",
   [r"perturbation (theory|expansion|analysis|method)", r"matched asymptotic", r"asymptotic expansion",
    r"\bsmall parameter", r"multiple scales", r"\bWKB\b"]),
  ("variational", "Variational / energy methods", "Calculus & analysis", "δ",
   "Deriving equations by minimizing an energy or action functional.",
   [r"variational", r"euler[- ]lagrange", r"free energy functional", r"minimi[sz]e the energy"]),
  # Probability / statistics
  ("gaussian", "Gaussian statistics", "Probability & stochastics", "🔔",
   "Normal distributions; the statistical basis of ideal chains and noise.",
   [r"gaussian (distribution|chain|statistics|noise|random)", r"normal distribution", r"\bbell curve"]),
  ("stochastic", "Stochastic / Brownian dynamics", "Probability & stochastics", "🎲",
   "Random-force dynamics: Brownian motion, Langevin and noise terms.",
   [r"brownian", r"langevin", r"stochastic (process|differential|force|dynamics)", r"random force", r"thermal noise"]),
  ("fokker", "Fokker–Planck / master equations", "Probability & stochastics", "ρ",
   "Evolution equations for probability distributions of stochastic systems.",
   [r"fokker[- ]planck", r"master equation", r"smoluchowski", r"probability (density|distribution) function"]),
  ("randomwalk", "Random walks", "Probability & stochastics", "🚶",
   "Step-by-step random processes; the model of polymer conformations & diffusion.",
   [r"random walk", r"self[- ]avoiding walk", r"\bdiffusiv", r"mean[- ]square displacement"]),
  ("correlation", "Correlation functions", "Probability & stochastics", "↹",
   "Statistical measures of how quantities relate across time/space.",
   [r"correlation function", r"autocorrelation", r"\bcovarianc"]),
  ("montecarlo", "Monte Carlo / sampling", "Probability & stochastics", "∎",
   "Estimating quantities by random sampling and simulation.",
   [r"monte carlo", r"importance sampling", r"metropolis"]),
  # Continuum mechanics / rheology
  ("navierstokes", "Navier–Stokes / fluid mechanics", "Continuum mechanics", "🌊",
   "Momentum balance for fluids; the core of hydrodynamics.",
   [r"navier[- ]stokes", r"momentum (balance|equation|conservation)", r"stokes (flow|drag|equation)"]),
  ("constitutive", "Constitutive / viscoelastic models", "Continuum mechanics", "🪢",
   "Stress–strain relations: Maxwell, Oldroyd, FENE and friends.",
   [r"constitutive (equation|model|relation)", r"viscoelastic", r"maxwell model", r"oldroyd", r"\bFENE\b", r"upper[- ]convected"]),
  ("conservation", "Conservation laws", "Continuum mechanics", "⚖",
   "Balance equations for mass, momentum and energy.",
   [r"conservation of (mass|momentum|energy)", r"continuity equation", r"mass balance", r"energy balance"]),
  ("dimensionless", "Dimensional analysis & numbers", "Continuum mechanics", "π",
   "Reducing problems via dimensionless groups (Re, We, De, Oh, Ca).",
   [r"dimensional analysis", r"dimensionless (number|group|parameter)", r"reynolds number", r"weber number",
    r"deborah number", r"ohnesorge", r"capillary number", r"buckingham"]),
  ("instability", "Stability & instability analysis", "Continuum mechanics", "🌀",
   "Linear stability, growth rates and Rayleigh–Plateau type breakup.",
   [r"linear stability", r"instabilit", r"rayleigh[- ]plateau", r"dispersion relation", r"growth rate"]),
  # Polymer physics
  ("scaling", "Scaling laws & power laws", "Polymer & scaling", "∝",
   "Relations of the form X ∼ N^a; self-similar and critical behavior.",
   [r"scaling (law|exponent|theory|argument|relation)", r"power[- ]law", r"self[- ]similar", r"\bN\^?\{?-?\d", r"\bcritical exponent"]),
  ("rouse", "Rouse / Zimm chain dynamics", "Polymer & scaling", "🧬",
   "Bead-spring chain relaxation with/without hydrodynamics.",
   [r"\brouse\b", r"\bzimm\b", r"bead[- ]spring", r"hydrodynamic interaction"]),
  ("reptation", "Reptation & tube theory", "Polymer & scaling", "🪱",
   "Entangled chain motion confined to a tube (Doi–Edwards).",
   [r"reptation", r"tube (model|theory|diameter)", r"entangle", r"doi[- ]edwards", r"primitive path"]),
  ("relaxation", "Relaxation time spectra", "Polymer & scaling", "τ",
   "Characteristic times governing viscoelastic and extensional response.",
   [r"relaxation time", r"relaxation (spectrum|modulus)", r"longest relaxation", r"\bdeformation retardation"]),
  ("chainstats", "Chain conformation statistics", "Polymer & scaling", "📏",
   "End-to-end distance, radius of gyration, persistence/Kuhn length.",
   [r"radius of gyration", r"end[- ]to[- ]end", r"kuhn (length|segment)", r"persistence length", r"contour length"]),
  ("elastocapillary", "Capillary thinning & pinch-off", "Polymer & scaling", "💧",
   "Thinning filaments balancing capillarity, viscosity and elasticity.",
   [r"elastocapillary", r"capillary thinning", r"pinch[- ]?off", r"filament (thinning|breakup)", r"CaBER"]),
  # Numerics / ML
  ("fem", "Finite element / finite difference", "Numerics & ML", "▱",
   "Discretizing PDEs on meshes/grids for numerical solution.",
   [r"finite element", r"finite difference", r"finite volume", r"\bmesh(ing)?\b", r"discretization"]),
  ("neuralnet", "Neural networks / deep learning", "Numerics & ML", "🧠",
   "Learned function approximators, incl. physics-informed networks.",
   [r"neural network", r"deep learning", r"physics[- ]informed", r"\bPINN", r"automatic differentiation"]),
  ("optimization", "Optimization & inverse problems", "Numerics & ML", "🎯",
   "Minimizing loss/objective functions; fitting and inverse inference.",
   [r"optimization", r"gradient descent", r"least[- ]squares", r"inverse problem", r"loss function", r"objective function"]),
]

CONCEPT_RE = [(c[0], re.compile("|".join(c[5]), re.I)) for c in CONCEPTS]

# math-font name fragments that signal real equation typesetting
MATH_FONT = re.compile(r"(MTMI|MTSY|CMMI|CMSY|CMEX|CMR|MSAM|MSBM|Symbol|Math|RMTMI|Italic-?Math)", re.I)
# strict math-italic / symbol fonts only (NOT roman body text) — for per-line math ratio
MATHGLYPH = re.compile(r"(MTMI|MTSY|CMMI|CMSY|CMEX|MSAM|MSBM|RSFS|EUSM|EUFM|Symbol|MathItalic|-Math|MdMath|RMTMI)", re.I)
MATHSYM = set("=∑∫∂∇√±×·∞≈≠≤≥≪≫αβγδεζηθϑικλμνξπρςστυφχψωΓΔΘΛΞΠΣΦΨΩ⟨⟩→←↔⇒∝∈∉⊗⊕∮∏˙¨^_/")
# fonts that signal mathematics: dedicated math fonts AND the Symbol/extra fonts that
# publisher PDFs use for operators even when variables are set in Times-Italic
SYMBOL_FONT = re.compile(r"(Symbol|MT-?Extra|MTEx|CMSY|CMEX|CMMI|MTMI|MTSY|MSAM|MSBM|RSFS|EUSM|EUFM|Math)", re.I)
EQNUM_RE = re.compile(r"^\(?\d{1,3}[a-z]?\)?\.?$")           # an equation number like (1) / 3a
REL_RE = re.compile(r"[=≈≤≥<>∝∼~]|∫|∑|∏|∂|∇|√|→|←")           # a relation/operator → real equation

def squeeze(s):
    return re.sub(r"\s+", " ", s).strip()


# ── symbolic equation-dependency flow ────────────────────────────────────────
_GREEK = set("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota "
             "kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi "
             "varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi "
             "Omega ell nabla partial".split())
_LATEXCMD = set("frac dfrac tfrac sqrt cdot cdots ldots vdots ddots times div ast star "
                "left right big Big bigg Bigg middle sum prod int iint iiint oint lim "
                "sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan sgn "
                "ln log exp max min sup inf arg det dim deg gcd hom ker Pr text textrm "
                "mathrm mathbf mathcal mathbb mathsf mathit boldsymbol bm hat widehat bar "
                "overline underline dot ddot vec tilde widetilde acute grave check breve "
                "begin end array matrix pmatrix bmatrix vmatrix cases aligned align quad "
                "qquad hspace vspace mathstrut prime approx equiv cong simeq sim propto leq "
                "geq neq ne ll gg le ge to gets mapsto rightarrow leftarrow Rightarrow "
                "Leftarrow leftrightarrow langle rangle lvert rvert lVert rVert pm mp in "
                "notin ni subset supset cup cap emptyset infty forall exists nabla "
                "displaystyle limits nolimits operatorname mathop space text mathscr "
                "mathfrak mathds scriptstyle scriptscriptstyle textstyle nonumber tag "
                "label notag mbox phantom".split())
_CONST = {"g:pi", "e", "i", "d"}                    # constants / differentials, not dependencies
_TOKRE = re.compile(r"\\?([A-Za-z]+)(_\{[^}]{1,12}\}|_[A-Za-z0-9])?")


def _eq_symbols(part):
    """Distinctive variable tokens in a LaTeX fragment (drops LaTeX command words, constants
    and bare common single letters; keeps Greek, multi-letter, subscripted, capital symbols)."""
    out = []
    for m in _TOKRE.finditer(part or ""):
        base, sub = m.group(1), m.group(2) or ""
        if base in _LATEXCMD:
            continue
        name = ("g:" + base if base in _GREEK else base) + sub
        if name in _CONST:
            continue
        if base in _GREEK or len(base) >= 2 or sub or base.isupper():
            out.append(name)
    return out


def build_eq_flow_symbolic(veqs):
    """Connect equations by shared derived quantities: equation j depends on the
    equation that DEFINES (has as its left-hand side) a symbol that j uses on its
    right-hand side. Deterministic, scales to hundreds of equations."""
    nodes = [{"idx": i, "label": e.get("label") or ("Eq " + str(i + 1)),
              "page": e.get("page"), "latex": e.get("latex", "")} for i, e in enumerate(veqs)]
    def_map = {}                                    # symbol -> [indices that define it]
    for i, e in enumerate(veqs):
        lx = e.get("latex", "")
        lhs = lx.split("=", 1)[0] if "=" in lx else ""
        for s in _eq_symbols(lhs):
            def_map.setdefault(s, []).append(i)
    # a symbol "defined" by very many equations is almost certainly a parse artifact
    def_map = {s: v for s, v in def_map.items() if len(v) <= 8}
    edges, seen = [], set()
    for j, e in enumerate(veqs):
        lx = e.get("latex", "")
        rhs = lx.split("=", 1)[1] if "=" in lx else lx     # symbols this equation USES
        cands = []
        for s in set(_eq_symbols(rhs)):
            defs = [i for i in def_map.get(s, []) if i != j]
            if defs:
                cands.append((min(defs, key=lambda x: abs(x - j)), s))
        cands.sort(key=lambda c: abs(c[0] - j))             # nearest first; cap to keep readable
        for i, s in cands[:5]:
            if (i, j) not in seen:
                seen.add((i, j))
                edges.append({"from": i, "to": j, "why": "uses " + s.replace("g:", "").replace("_", "")})
    return {"nodes": nodes, "edges": edges, "src": "symbolic"}


def eq_number(text):
    """Best-effort: extract an equation's printed number from its (messy) crop text.
    Handles fragmented band-detected text where the number sits mid-string after a
    right-margin dotted leader, as well as clean trailing '(N)'."""
    if not text:
        return None
    t = text.strip()
    m = re.search(r"[.…·•]{2,}\s*\(?\s*(\d{1,3}[a-z]?)\s*\)?", t)   # right-margin dotted-leader (3)
    if m:
        return m.group(1)
    m = re.search(r"\(\s*(\d{1,3}[a-z]?)\s*\)\s*$", t)              # …expr (3)
    return m.group(1) if m else None

NOISE_RE = re.compile(r"(https?://|www\.|doi|downloaded|journalcode|^\s*fig\.?\b|^\s*table\b|"
                      r"^\s*references|copyright|all rights reserved|©)", re.I)

def looks_equation(line):
    l = line.strip()
    if len(l) < 3 or len(l) > 140:
        return False
    if NOISE_RE.search(l):
        return False
    dens = sum(ch in MATHSYM for ch in l)
    if dens < 2:
        return False
    # needs a relation or operator pattern, not just a stray symbol-laden sentence
    if not re.search(r"[=≈≤≥<>∝~]|∂|∑|∫|∇|\^|_\{", l):
        return False
    # reject OCR garbage: require a healthy ratio of meaningful glyphs
    meaningful = sum(ch.isalnum() or ch in MATHSYM or ch in "()[]{}+-*/.,;:|" for ch in l)
    if meaningful / max(1, len(l)) < 0.72:
        return False
    # must contain at least one variable-like letter and not read as a sentence
    if not re.search(r"[A-Za-zα-ωΑ-Ω]", l):
        return False
    # reject prose: real equation lines rarely carry English stop-words
    stop = re.findall(r"\b(the|and|with|that|this|which|from|respectively|figure|fig|table|"
                      r"associated|between|geometry|observed|where|when|using|shown|are|was|"
                      r"obtained|given|such|these|those|into|than|then)\b", l, re.I)
    if len(stop) >= 2:
        return False
    words = re.findall(r"[A-Za-z]{4,}", l)
    return len(words) <= 5

def guess_meta(fname):
    base = os.path.splitext(os.path.basename(fname))[0]
    year = None
    m = re.search(r"\b(18|19|20)\d{2}\b", base)
    if m: year = m.group(0)
    # title = strip "Authors - YEAR - " prefix if present
    title = re.sub(r"^.*?-\s*(18|19|20)\d{2}\s*-\s*", "", base)
    title = re.sub(r"^\s*-\s*", "", title)
    authors = base.split(" - ")[0] if " - " in base else ""
    return squeeze(title)[:160] or base[:160], authors[:80], year

def eq_line_from_dict(line):
    """Return (text, bbox, is_eq, mathy). is_eq flags *display*-equation lines and
    deliberately rejects ordinary prose that merely contains inline math."""
    spans = line.get("spans", [])
    text = squeeze("".join(s.get("text", "") for s in spans))
    fonts = " ".join(s.get("font", "") for s in spans)
    mathy = bool(MATH_FONT.search(fonts))
    glyph = sum(len(s.get("text", "")) for s in spans if MATHGLYPH.search(s.get("font", "") or ""))
    total = sum(len(s.get("text", "")) for s in spans) or 1
    math_ratio = glyph / total
    words3 = len(re.findall(r"[A-Za-z]{3,}", text))
    has_rel = bool(re.search(r"[=≈≤≥<>∝~]|∂|∑|∫|∇|\^|_\{", text))
    if glyph > 0:
        # line uses real math glyphs: keep it only if it's *mostly* math (a display
        # equation), which rejects prose that merely contains an inline symbol
        is_eq = has_rel and math_ratio >= 0.42 and words3 <= 6 and 2 <= len(text) <= 220
    else:
        # no math fonts (e.g. Times-set math): fall back to strict symbol heuristic
        is_eq = looks_equation(text) and words3 <= 3
    return text, line.get("bbox"), is_eq, mathy


def merge_eq_lines(lines):
    """Group vertically-adjacent equation lines into one display block (captures
    fractions, stacked terms and the equation number), but cap the block height so
    a whole paragraph can never be swallowed."""
    lines = sorted([l for l in lines if l[1]], key=lambda l: (round(l[1][1]), l[1][0]))
    blocks = []
    for text, bbox, *_ in lines:
        if blocks:
            bx0, by0, bx1, by1 = blocks[-1]["bbox"]
            new_h = max(by1, bbox[3]) - min(by0, bbox[1])
            if bbox[1] - by1 < 10 and bbox[0] <= bx1 + 160 and new_h <= 64:
                blocks[-1]["bbox"] = [min(bx0, bbox[0]), min(by0, bbox[1]),
                                      max(bx1, bbox[2]), max(by1, bbox[3])]
                blocks[-1]["text"] = squeeze(blocks[-1]["text"] + " " + text)
                blocks[-1]["n"] += 1
                continue
        blocks.append({"text": text, "bbox": list(bbox), "n": 1})
    return blocks


def _line_info(line):
    spans = line.get("spans", [])
    text = squeeze("".join(s.get("text", "") for s in spans))
    fonts = [s.get("font", "") or "" for s in spans]
    has_sym = any(SYMBOL_FONT.search(f) for f in fonts) or any(ch in MATHSYM for ch in text)
    words = len(re.findall(r"[A-Za-z]{3,}", text))
    return {"text": text, "bbox": line.get("bbox"), "has_sym": has_sym, "words": words}


def is_real_equation(text):
    """Keep genuine display equations; reject figure legends, axis labels and OCR
    gibberish that a band may have picked up (esp. on OCR'd scanned pages)."""
    if not REL_RE.search(text):
        return False
    # the relation must sit next to a math operand on at least one side (variable,
    # number, paren, Greek letter or operator) — unicode-aware — or be an integral /
    # derivative / sum form. Rejects a stray "=" floating in a figure label.
    op = r"[\w)\]}α-ωΑ-Ωϑϕϱ∞]"
    rel = r"[=≈≤≥∝∼<>≠]"
    structured = (re.search(op + r"[^A-Za-z\n]{0,4}" + rel, text)
                  or re.search(rel + r"[^A-Za-z\n]{0,4}[\w(\[α-ωΑ-Ω√∫∂−+\-]", text)
                  or re.search(r"[∫∑∏∂∇√]", text))
    if not structured:
        return False
    if re.search(r"([A-Za-z])\1\1", text):                 # eee / nnn → OCR noise
        return False
    if len(re.findall(r"[A-Za-z]{4,}", text)) > 2:         # figure legends / prose words
        return False
    if len(re.findall(r"[A-Za-z]{3,}", text)) > 8:
        return False
    return True


def detect_equations(page):
    """Band-based display-equation detection. Robust to PDFs that set math in
    Times-Italic + Symbol fonts (variables not in a dedicated math font): find
    'seed' lines carrying math symbols, then grow a bounding box over the local
    cluster of short fragments (fraction numerator/denominator, operators, the
    equation number) while refusing to absorb prose lines."""
    d = page.get_text("dict")
    lines = []
    for b in d.get("blocks", []):
        if b.get("type", 0) != 0:
            continue
        for ln in b.get("lines", []):
            info = _line_info(ln)
            if info["bbox"] and info["text"]:
                lines.append(info)
    lines.sort(key=lambda l: (round(l["bbox"][1]), l["bbox"][0]))
    used = [False] * len(lines)
    blocks = []
    for i, l in enumerate(lines):
        if used[i] or not (l["has_sym"] and l["words"] <= 5):
            continue
        top, bot = l["bbox"][1] - 22, l["bbox"][3] + 22      # ~2 text lines up/down
        members = []
        for j, lj in enumerate(lines):
            if used[j]:
                continue
            cy = (lj["bbox"][1] + lj["bbox"][3]) / 2
            # absorb only math fragments — a symbol-bearing short line, a 1–2 word
            # piece (fraction numerator/denominator), or an equation number; never
            # multi-word prose, even when it sits right above the equation
            is_frag = (EQNUM_RE.match(lj["text"]) or lj["words"] <= 2
                       or (lj["has_sym"] and lj["words"] <= 4))
            if top <= cy <= bot and is_frag:
                members.append(j)
        for m in members:
            used[m] = True
        members.sort(key=lambda m: (round(lines[m]["bbox"][1]), lines[m]["bbox"][0]))
        text = squeeze(" ".join(lines[m]["text"] for m in members))
        if not is_real_equation(text):
            continue
        xs = [lines[m]["bbox"] for m in members]
        bbox = [min(b[0] for b in xs), min(b[1] for b in xs),
                max(b[2] for b in xs), max(b[3] for b in xs)]
        if bbox[2] - bbox[0] >= 30:
            blocks.append({"text": text, "bbox": bbox})
    blocks.sort(key=lambda b: b["bbox"][1])
    return blocks


def extract_pdf(path, max_pages, max_eqs=18):
    try:
        doc = fitz.open(path)
    except Exception:
        return None
    page_count = doc.page_count
    n = min(page_count, max_pages)
    pages = []          # list of (pageno, text)
    eqs = []            # (text, page, bbox)
    has_math_font = False
    for pi in range(n):
        try:
            page = doc.load_page(pi)
            for f in page.get_fonts():
                if MATH_FONT.search(f[3] or ""):
                    has_math_font = True
            txt = page.get_text("text")
        except Exception:
            continue
        pages.append((pi + 1, txt))
        try:
            for blk in detect_equations(page):
                eqs.append((blk["text"], pi + 1, blk["bbox"]))
        except Exception:
            pass
    doc.close()
    fulltext = "\n".join(t for _, t in pages)
    # dedup equations, keep page order (≈ derivation sequence), number them
    seen = set(); deduped = []
    for e, pg, bbox in eqs:
        k = re.sub(r"\s", "", e)
        if k in seen: continue
        seen.add(k)
        deduped.append({"seq": len(deduped) + 1, "text": e, "page": pg, "bbox": bbox})
        if len(deduped) >= max_eqs: break
    return pages, fulltext, deduped, page_count, has_math_font


def render_equations(path, eqs, img_dir, pid, zoom=3.0, max_imgs=14):
    """Crop each equation's region out of the real PDF page and save it as a PNG,
    so it renders exactly as printed (true LaTeX typesetting)."""
    try:
        doc = fitz.open(path)
    except Exception:
        return
    mat = fitz.Matrix(zoom, zoom)
    rendered = 0
    for eq in eqs:
        bbox = eq.pop("bbox", None)
        if bbox is None or rendered >= max_imgs:
            continue
        try:
            page = doc.load_page(eq["page"] - 1)
            pr = page.rect
            # pad the crop a little so super/subscripts aren't clipped
            rect = fitz.Rect(max(pr.x0, bbox[0] - 6), max(pr.y0, bbox[1] - 5),
                             min(pr.x1, bbox[2] + 6), min(pr.y1, bbox[3] + 5))
            if rect.width < 12 or rect.height < 6:
                continue
            pix = page.get_pixmap(matrix=mat, clip=rect, alpha=False)
            fname = f"{pid}-{eq['seq']}.png"
            pix.save(os.path.join(img_dir, fname))
            eq["img"] = f"data/eq/{fname}"
            eq["w"] = round(rect.width)
            rendered += 1
        except Exception:
            continue
    doc.close()

def find_concepts(pages, fulltext):
    out = []
    for cid, rgx in CONCEPT_RE:
        hits = list(rgx.finditer(fulltext))
        if len(hits) < 2:        # require ≥2 mentions — a single stray match is incidental, not a method "used"
            continue
        m = hits[0]
        a = max(0, m.start() - 110); b = min(len(fulltext), m.end() + 110)
        snip = squeeze(fulltext[a:b])
        # pages where the concept appears — used to link math buttons to equations
        pgs = sorted({pg for pg, t in pages if rgx.search(t)})
        out.append({"id": cid, "count": len(hits), "snippet": snip[:240], "pages": pgs[:14]})
    return out

# ── sector classification (which domain a PDF belongs to) ─────────────────────
SECTORS = [
  ("Atomization & sprays",
   [r"atomiz", r"\bspray", r"nozzle", r"jet break[- ]?up", r"droplet size distribution", r"sauter", r"\bSMD\b"]),
  ("Capillary breakup & pinch-off",
   [r"pinch[- ]?off", r"capillary thinning", r"\bfilament", r"beads?[- ]on[- ]a?[- ]?string",
    r"rayleigh[- ]plateau", r"\bCaBER", r"liquid bridge", r"thread"]),
  ("Polymer dynamics & rheology",
   [r"\brouse\b", r"\bzimm\b", r"reptation", r"viscoelastic", r"relaxation time", r"entangle",
    r"\bpolymer", r"extensional rheolog", r"constitutive"]),
  ("Droplet evaporation & drying",
   [r"evaporat", r"\bdrying\b", r"spray[- ]dry", r"particle formation", r"levitat", r"sessile drop", r"desiccat"]),
  ("Suspensions, gels & food rheology",
   [r"suspension", r"colloid", r"nanofluid", r"emulsion", r"\bgel\b", r"\bgum\b", r"pur[ée]e",
    r"\bjuice", r"\bstarch", r"\bpulp\b", r"food"]),
  ("Machine learning & numerics",
   [r"neural network", r"deep learning", r"physics[- ]informed", r"\bPINN", r"finite element",
    r"finite difference", r"machine learning", r"surrogate model"]),
  ("Interfacial & fluid dynamics",
   [r"surface tension", r"instabilit", r"navier[- ]stokes", r"free surface", r"interfac",
    r"hydrodynamic", r"capillary wave"]),
]
SECTOR_RE = [(name, re.compile("|".join(p), re.I)) for name, p in SECTORS]

def classify_sector(title, fulltext):
    text = title + " " + fulltext[:6000]
    best, score = "Other / general", 0
    for name, rgx in SECTOR_RE:
        s = len(rgx.findall(text))
        if s > score:
            score, best = s, name
    return best

# ── concept-card sections: objective / assumptions / BCs / governing eqs ──────
SENT_SPLIT = re.compile(r"(?<=[\.\?;])\s+(?=[A-Z(\\])")
def sentences(fulltext, limit=16000):
    t = re.sub(r"-\n", "", fulltext[:limit])   # de-hyphenate across line breaks
    t = re.sub(r"\s+", " ", t)
    return [s.strip() for s in SENT_SPLIT.split(t) if 28 <= len(s.strip()) <= 340]

OBJ_RE = re.compile(r"\b(we (present|propose|study|investigate|develop|report|examine|show|derive|model|introduce)|"
                    r"the (aim|goal|objective|purpose|focus) of|in this (paper|work|study|article|letter)[, ]|"
                    r"this (paper|work|study|article) (presents|investigates|studies|develops|reports|examines|describes)|here,? we)\b", re.I)
ASSUM_RE = re.compile(r"\b(we assume|assumption|is assumed|are assumed|we neglect|neglect(ed|ing)?|is negligible|negligibl|"
                      r"idealiz|for simplicity|we take .{0,30}(constant|uniform)|incompressible|isotherm|steady[- ]state|"
                      r"newtonian fluid|dilute limit|we consider .{0,30} to be)\b", re.I)
BC_RE = re.compile(r"\b(boundary condition|no[- ]slip|free[- ]slip|at the (wall|interface|surface|inlet|outlet|axis|centerline)|"
                   r"initial condition|far[- ]field|symmetry condition|at r ?=|at x ?=|at z ?=|as r ?(→|->|tends)|"
                   r"prescribed (velocity|pressure|flux))\b", re.I)
GOV_RE = re.compile(r"\b(governing equation|conservation of (mass|momentum|energy)|continuity equation|momentum equation|"
                    r"navier[- ]stokes|equation of motion|constitutive equation|cauchy momentum|balance equation|"
                    r"transport equation)\b", re.I)

def extract_sections(fulltext):
    sents = sentences(fulltext)
    def pick(rgx, k):
        out, seen = [], set()
        for s in sents:
            if rgx.search(s):
                key = s[:60].lower()
                if key in seen: continue
                seen.add(key); out.append(s)
                if len(out) >= k: break
        return out
    return {
        "objective": pick(OBJ_RE, 2),
        "assumptions": pick(ASSUM_RE, 6),
        "boundary": pick(BC_RE, 6),
        "governing": pick(GOV_RE, 6),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zdb", default=DEFAULT_ZDB)
    ap.add_argument("--limit", type=int, default=0, help="max PDFs (0 = all)")
    ap.add_argument("--pages", type=int, default=30, help="max pages per PDF")
    ap.add_argument("--no-images", action="store_true", help="skip rendering equation crops")
    args = ap.parse_args()

    pdfs = []
    for root, _, files in os.walk(args.zdb):
        for f in files:
            if f.lower().endswith(".pdf"):
                pdfs.append(os.path.join(root, f))
    pdfs.sort()
    if args.limit:
        pdfs = pdfs[:args.limit]
    total = len(pdfs)
    print(f"Scanning {total} PDFs (<= {args.pages} pages each)…", flush=True)

    # fresh equation-image folder (true-to-PDF crops)
    img_dir = os.path.join(DATA, "eq")
    if not args.no_images:
        if os.path.isdir(img_dir):
            shutil.rmtree(img_dir, ignore_errors=True)
        os.makedirs(img_dir, exist_ok=True)

    papers = []
    concept_papers = {c[0]: [] for c in CONCEPTS}
    t0 = time.time()
    for i, p in enumerate(pdfs):
        res = extract_pdf(p, args.pages)
        if i % 25 == 0:
            print(f"  [{i}/{total}] {time.time()-t0:5.1f}s  {os.path.basename(p)[:54]}", flush=True)
        if not res:
            continue
        pages_list, fulltext, eqs, page_count, mathfont = res
        if len(fulltext) < 200:
            continue  # scanned/empty PDF, skip
        concepts = find_concepts(pages_list, fulltext)
        if not concepts and not eqs:
            continue
        title, authors, year = guess_meta(p)
        pid = f"p{len(papers)}"
        rel = os.path.relpath(p, args.zdb)
        if not args.no_images:
            render_equations(p, eqs, img_dir, pid)   # mutates eqs: adds img, drops bbox
        else:
            for e in eqs:
                e.pop("bbox", None)
        paper = {
            "id": pid, "title": title, "authors": authors, "year": year,
            "file": rel, "pages": page_count, "mathFont": mathfont,
            "sector": classify_sector(title, fulltext),
            # each math the paper uses, with the pages where it appears (links to eqs)
            "concepts": [{"id": c["id"], "count": c["count"], "pages": c["pages"]} for c in concepts],
            "equations": eqs,                        # ordered, numbered, with pages
            "sections": extract_sections(fulltext),  # objective / assumptions / BC / governing
        }
        papers.append(paper)
        for c in concepts:
            concept_papers[c["id"]].append({"paper": pid, "count": c["count"], "snippet": c["snippet"]})

    # assemble concept index, sorted by evidence strength
    concepts_out = []
    for cid, label, cat, icon, defn, _pat in CONCEPTS:
        ev = sorted(concept_papers[cid], key=lambda x: -x["count"])
        concepts_out.append({
            "id": cid, "label": label, "category": cat, "icon": icon,
            "definition": defn, "paperCount": len(ev), "evidence": ev[:40],
        })

    # concept co-occurrence (shared papers) — kept for optional graph use
    cooc = {}
    for pap in papers:
        cs = [c["id"] for c in pap["concepts"]]
        for a in range(len(cs)):
            for b in range(a + 1, len(cs)):
                k = tuple(sorted((cs[a], cs[b])))
                cooc[k] = cooc.get(k, 0) + 1
    edges = [{"a": a, "b": b, "w": w} for (a, b), w in cooc.items() if w >= 2]
    edges.sort(key=lambda e: -e["w"])

    # sectors index: domain -> paper ids, sorted by size
    sectors = {}
    for pap in papers:
        sectors.setdefault(pap["sector"], []).append(pap["id"])
    sectors_out = sorted(
        ({"name": k, "paperIds": v, "count": len(v)} for k, v in sectors.items()),
        key=lambda s: -s["count"])

    out = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "zdbPath": os.path.abspath(args.zdb),
        "corpusSize": total,
        "paperCount": len(papers),
        "concepts": concepts_out,
        "papers": papers,
        "edges": edges,
        "sectors": sectors_out,
        "categories": sorted({c[2] for c in CONCEPTS}),
    }
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "knowledge.json"), "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DATA, "knowledge.js"), "w") as f:
        f.write("window.RHEO_KNOWLEDGE = ")
        json.dump(out, f, ensure_ascii=False)
        f.write(";\n")
    print(f"\nDone in {time.time()-t0:.1f}s — {len(papers)} papers with math content, "
          f"{len(edges)} concept edges. Wrote data/knowledge.json (+.js)")

if __name__ == "__main__":
    main()
