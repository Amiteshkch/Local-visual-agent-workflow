# 🔶 Workflow Engine — Local Backend

Run your workflows **24/7** without a browser. This Node.js server persists workflows to disk, executes them on schedule, and exposes a REST API the frontend connects to.

---

## Quick Start (without Docker)

```bash
npm install
node server.js
```

Server runs at: **http://localhost:3001**

---

## Quick Start (with Docker — recommended)

```bash
# 1. Install Docker Desktop → https://docker.com/get-started

# 2. Build and start (one command)
docker compose up -d

# 3. Check it's running
curl http://localhost:3001/api/health

# 4. View live logs
docker compose logs -f
```

Or use the deploy script:
```bash
chmod +x deploy.sh && ./deploy.sh
```

---

## Save Credentials

### Option A — via curl (quick)
```bash
curl -X POST http://localhost:3001/api/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "anthropicApiKey": "sk-ant-...",
    "slackToken": "xoxb-...",
    "gmailToken": "ya29...."
  }'
```

### Option B — via .env file + deploy script
```bash
cp .env.example .env
# Edit .env with your keys
./deploy.sh   # automatically saves them
```

Credentials are stored server-side in `storage/credentials.json` — **never sent to the browser**.

---

## Deploy to the Cloud (run 24/7 on a real server)

### Option 1 — Railway (easiest, free tier available)
```bash
# 1. Push to GitHub
git init && git add . && git commit -m "init"
gh repo create my-workflow-engine --public --push

# 2. Go to railway.app → New Project → Deploy from GitHub
# 3. Set environment variables in Railway dashboard
# 4. Done — your engine runs 24/7 at a public URL
```

### Option 2 — Render (free tier, auto-deploy)
```bash
# 1. Push to GitHub (same as above)
# 2. Go to render.com → New Web Service → Connect GitHub repo
# 3. Build command: npm install
# 4. Start command: node server.js
# 5. Add env vars in Render dashboard
```

### Option 3 — DigitalOcean Droplet ($6/month, full control)
```bash
# On your Droplet (Ubuntu):
apt install docker.io docker-compose-plugin -y
git clone https://github.com/yourname/workflow-engine
cd workflow-engine
cp .env.example .env && nano .env   # fill in your keys
./deploy.sh
```

---

## File Structure

```
workflow-engine/
├── server.js              ← Express API server
├── Dockerfile             ← Container definition
├── docker-compose.yml     ← Orchestration (volumes, restart policy)
├── deploy.sh              ← One-click deploy script
├── .env.example           ← Environment variable template
├── package.json
├── engine/
│   ├── executor.js        ← Topological sort + node runner
│   ├── scheduler.js       ← Cron-based schedule triggers
│   └── nodes/
│       └── index.js       ← Claude, Slack, Gmail, HTTP handlers
└── storage/
    ├── index.js           ← File-based persistence layer
    ├── credentials.json   ← Your API keys (auto-created, gitignored)
    ├── workflows/         ← One JSON file per saved workflow
    └── logs/              ← One JSON file per execution
```

---

## API Reference

### Workflows
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workflows` | List all saved workflows |
| GET | `/api/workflows/:id` | Get a single workflow |
| POST | `/api/workflows` | Save a new workflow |
| PUT | `/api/workflows/:id` | Update an existing workflow |
| DELETE | `/api/workflows/:id` | Delete a workflow |

### Execution
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/execute/:id` | Run a saved workflow by ID |
| POST | `/api/execute` | Run a raw workflow object |
| POST | `/api/webhook/:path` | Trigger workflow via webhook |

### Logs & Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs` | All execution logs |
| GET | `/api/logs?workflowId=X&limit=50` | Filtered logs |
| GET | `/api/health` | Server status + active cron jobs |

---

## Docker Commands Cheatsheet

```bash
docker compose up -d          # Start in background
docker compose down           # Stop everything
docker compose restart        # Restart after code change
docker compose logs -f        # Live logs
docker compose ps             # Check container status
docker compose build          # Rebuild image after code change
```

---

## Layer 7 Ideas (future)
- [ ] SQLite instead of JSON files
- [ ] Live dashboard UI (React) showing workflow status
- [ ] Retry logic with exponential backoff
- [ ] Failure alerts via email or Slack
- [ ] Multi-user support with auth


In your React workflow builder, change the Execute button to call the backend instead of running locally:

```js
// Instead of running in the browser:
const res = await fetch("http://localhost:3001/api/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(workflow),
});
const log = await res.json();
```

---

## Save Credentials (one-time setup)

```bash
curl -X POST http://localhost:3001/api/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "anthropicApiKey": "sk-ant-api03-...",
    "slackToken": "xoxb-...",
    "gmailToken": "ya29...."
  }'
```

Credentials are stored in `storage/credentials.json` — **never sent back to the browser**.

---

## API Reference

### Workflows
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workflows` | List all saved workflows |
| GET | `/api/workflows/:id` | Get a single workflow |
| POST | `/api/workflows` | Save a new workflow |
| PUT | `/api/workflows/:id` | Update an existing workflow |
| DELETE | `/api/workflows/:id` | Delete a workflow |

### Execution
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/execute/:id` | Run a saved workflow by ID |
| POST | `/api/execute` | Run a raw workflow object |
| POST | `/api/webhook/:path` | Trigger workflow via webhook |

### Logs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs` | All execution logs |
| GET | `/api/logs?workflowId=X` | Logs for a specific workflow |
| GET | `/api/logs?limit=50` | Control how many logs returned |

### Credentials
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/credentials` | Save API keys/tokens |
| GET | `/api/credentials/status` | Check which keys are set (values hidden) |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server status + active scheduled jobs |

---

## Scheduled Workflows (runs 24/7)

Any workflow with a **Schedule** node will automatically run on its cron schedule when the server is running.

Example cron expressions:
```
0 9 * * 1-5     → 9 AM every weekday
*/30 * * * *    → Every 30 minutes
0 0 * * *       → Daily at midnight
0 9 * * 1       → Every Monday at 9 AM
```

---

## Webhook Triggers

Any workflow with a **Webhook** node (path: `/my-trigger`) can be triggered externally:

```bash
curl -X POST http://localhost:3001/api/webhook/my-trigger \
  -H "Content-Type: application/json" \
  -d '{"event": "payment_failed", "amount": 99}'
```

This payload is available in downstream nodes as `{{previousOutput.event}}`.

---

## File Structure

```
workflow-engine/
├── server.js              ← Express API server (start here)
├── package.json
├── engine/
│   ├── executor.js        ← Topological sort + node runner
│   ├── scheduler.js       ← Cron-based schedule triggers
│   └── nodes/
│       └── index.js       ← Claude, Slack, Gmail, HTTP handlers
└── storage/
    ├── index.js           ← File-based persistence layer
    ├── credentials.json   ← Your API keys (auto-created, gitignored)
    ├── workflows/         ← One JSON file per saved workflow
    └── logs/              ← One JSON file per execution
```

---

## Layer 6 Ideas (future improvements)

- [ ] SQLite database instead of JSON files (better for many workflows)
- [ ] Dashboard UI showing live execution status
- [ ] Retry logic with exponential backoff on node failure
- [ ] Email/Slack alert when a workflow fails
- [ ] Docker container for always-on cloud deployment
- [ ] Workflow versioning and rollback
