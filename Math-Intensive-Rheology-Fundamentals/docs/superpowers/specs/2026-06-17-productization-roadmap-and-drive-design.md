# Productization Bridge + Google Drive Storage — Design

Date: 2026-06-17
Branch: `single-pdf-derivation`
Decision: **"Personal now, product later."** Build a solid personal app today with clean
seams so a future multi-user/cloud product is a drop-in, not a rewrite. Defer all
hosting/auth/GPU cost.

## Goal

1. Keep the **PWA as the installable app** (already done) — no new app-store toolchain now.
2. Use **Google Drive as the cloud store** for uploaded PDFs + their extracted data, so all
   the user's devices share one library that is cloud-backed.
3. **Detect duplicate uploads** and show a popup instead of silently reprocessing.
4. Add **light seams** (identity chokepoint, per-user storage param, device registry) so
   accounts + a 3-device cap + per-account cloud can be added later without a rewrite.
5. Write the full **SaaS roadmap** so the deferred work is documented and ordered.

## Key facts this leans on
- The project lives inside the **mounted Google Drive** (`My Drive/LLM/n8n_like_agent/…`), so
  `uploads/library/` already syncs to Drive via the desktop app — cloud storage with no API.
- Each paper's id is **`sha1(file_bytes)[:12]`**, so exact-duplicate PDFs map to the same
  entry from any device — dedup is essentially already computed.
- All devices are thin clients to the one Mac server, so the library is already "synced."

---

## NOW — build (small, no hosting, no behavior change to what works)

### 1. Google Drive as the store (via the desktop mount)
- Library storage stays under the Drive-synced project folder (it already is). Make it
  explicit/tidy: a single `LIB_DIR` that resolves to a clear Drive-synced location
  (default: current `uploads/library/`, which is inside My Drive). No API/OAuth.
- PDFs + `paper.json` + `eq/` crops + vision data all sync to Drive automatically →
  cloud backup + the single source every device reads through the Mac server.
- `uploads/` stays **gitignored** (Drive is the file store; git is for code).

### 2. Duplicate detection + popup
- In `POST /api/extract`: after computing `pid = sha1(raw)[:12]`, if a **fully-processed**
  entry already exists (`load_paper(pid)` has equations/visionEqs or bigBook flag), return
  `{ duplicate: true, paper: existing }` (HTTP 200) instead of re-extracting.
- Frontend (`upload.js` dropzone handler — not the graph code): on `duplicate`, show a popup
  *"Already in your library — added {date}. Opening it."* and load the existing paper.
- A "re-process anyway" affordance in the popup forces a fresh run (skips the short-circuit).

### 3. Identity chokepoint seam (the one that matters)
- `current_principal(request)` in `server.py` → today `{ user: "local", device: <id from a
  `wbdev` cookie, minted if absent> }`. This is the single place Google-OAuth token
  validation drops in later.
- `lib_dir_for(user)` storage helper → today returns the existing `LIB_DIR` for any user
  (so **no data migration**); later returns a per-account dir/Drive path.

### 4. Device registry (real now, cap deferred)
- Track devices that connect (by the `wbdev` cookie): id, first/last seen, user-agent.
- `GET /api/devices` → the list; a small **"Connected devices"** readout in the sidebar.
- `MAX_DEVICES = 3` constant + enforcement code **gated behind `ENFORCE_DEVICE_CAP`
  (default False)** — capping your own devices is meaningless until real accounts exist.

---

## LATER — roadmap (documented, NOT built now; no cost incurred today)

Ordered phases for the multi-user product:
1. **Google OAuth** sign-in → real `user` identity (replaces `"local"`) at the
   `current_principal` chokepoint.
2. **Per-account Google Drive (Drive API)** — each user's PDFs/data live in *their own*
   Drive (app folder). Removes the need to host a big file store; the user's Drive is the
   store. Devices upload → server (or device) writes to that user's Drive.
3. **Control-plane backend + small DB** — only metadata: users, devices/sessions, library
   index. Files stay in Drive. Cheap to host.
4. **Cross-account sync** — the Drive folder per account is the source of truth; devices
   reconcile against it (replaces "one Mac = source of truth").
5. **Enforce max-3 device sessions** — flip `ENFORCE_DEVICE_CAP`; reject/388 the 4th active
   session per account, with a "sign out another device" prompt.
6. **Cloud GPU for vision/OCR** (the real cost driver) — OR keep compute on a user-run
   worker node so hosting stays cheap. Decide at this phase.
7. **Optional packaged apps** — Android APK (TWA) / desktop (Tauri) wrapping the PWA.

## Data shapes
```jsonc
// device registry entry (now)
{ "id": "<cookie>", "ua": "...", "firstSeen": "2026-06-17 10:00", "lastSeen": "..." }
// duplicate upload response (now)
{ "duplicate": true, "paper": { ...existing paper.json... } }
```

## Files touched (now)
- `server.py` — `current_principal`, `lib_dir_for(user)`, device registry + `GET /api/devices`,
  duplicate short-circuit in `/api/extract`, `MAX_DEVICES`/`ENFORCE_DEVICE_CAP`.
- `upload.js` — duplicate popup in the upload handler; small "Connected devices" readout
  (both **outside** the graph code Codex owns).
- `styles.css` — popup + devices-readout styling (non-graph).

## Verification (now)
- Re-upload an existing PDF (e.g. a library paper) → `duplicate:true`, popup shown, existing
  paper opened, **no reprocessing**; "re-process anyway" forces a fresh run.
- A new PDF still extracts normally and lands in the Drive-synced folder.
- `GET /api/devices` lists the connecting devices; the readout shows them.
- Confirm the library folder path resolves inside the mounted Google Drive.
- With `ENFORCE_DEVICE_CAP=False`, a 4th device still connects (cap not active).

## Out of scope / YAGNI (now)
- OAuth, hosted backend, DB, Drive API, cloud GPU, cap enforcement, packaged native apps —
  all in the roadmap, none built now.
- No data migration (the `user` param defaults to today's exact paths).
