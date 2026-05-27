# Local Visual Agent Workflow

A local-first, n8n-inspired visual workflow builder that connects to a folder on your machine, scans its files, and generates a draggable AI-agent workflow canvas — all inside the browser, with no file uploads and no backend required.

## Features

- **Visual canvas** — drag, connect, and arrange agent nodes using React Flow.
- **Folder-aware** — requests browser permission to a local folder and routes files into Documents, Code, Images, Data, and Other branches automatically.
- **AI Model Providers** — configure the model backend used for Suggest / Simulate:
  - **Ollama (local, free)** — runs entirely on your machine; no API key needed.
  - **Google Gemini (free tier)** — add your Gemini API key in the sidebar.
  - **Anthropic Claude (paid)** — add your Anthropic API key in the sidebar.
- **Template** — load a pre-built starter workflow for common agent patterns.
- **Suggest** — let the selected AI model propose next steps based on your current canvas.
- **Simulate** — dry-run the workflow and preview what each node would produce.
- **Export** — download `local-agent-workflow.json` (n8n-inspired format).
- **Agent tool palette** — searchable sidebar with Web Research Agent, HTTP/API Request, Document Extractor, Table/CSV Analyzer, Data Cleaner, Python Analysis Step, Chart Builder, Classifier/Tagger, Insight Summarizer, Report Writer, Manual Trigger, Schedule Trigger, and more.

## Requirements

- **Node.js 18+**
- **Chrome or Edge** recommended (uses `showDirectoryPicker()` for folder access; Safari/Firefox fall back to a file input).
- _(Optional)_ [Ollama](https://ollama.com/) for free local AI suggestions.

## Installation & Setup

```bash
# Clone the repo
git clone https://github.com/Amiteshkch/Local-visual-agent-workflow.git
cd Local-visual-agent-workflow

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open the URL printed by Vite (default: `http://127.0.0.1:5173`).

## How to Use

### 1. Connect a Folder
Click **Connect local folder** in the sidebar and grant the browser permission to a folder on your machine. The app scans file names, paths, sizes, types, and dates — it never reads file contents.

### 2. Choose an AI Model Provider
In the **AI Model Provider** section of the sidebar, pick one:

| Provider | Cost | Setup |
|---|---|---|
| Ollama (local) | Free | Install [Ollama](https://ollama.com/), pull a model (`ollama pull qwen2.5:3b`), then set the Ollama URL (default: `http://localhost:11434`) and model name in the sidebar. |
| Google Gemini | Free tier | Paste your Gemini API key in the sidebar. |
| Anthropic Claude | Paid | Paste your Anthropic API key in the sidebar. |

Click **Save & activate** after entering credentials.

### 3. Build Your Workflow
- Click **Template** to load a starter workflow.
- Drag tools from the **Agent tools** palette onto the canvas, or click **Add**.
- Connect nodes by dragging from one handle to another.
- Click **Suggest** to have the AI recommend next nodes based on your current graph.
- Click **Simulate** to preview a dry-run of the workflow.

### 4. Export
Click **Export** to download `local-agent-workflow.json` — an n8n-inspired workflow file you can inspect or extend.

## Build for Production

```bash
npm run build   # outputs to dist/
npm run preview # serve the built output locally
```

## Privacy

- Folder access is permission-gated by the browser's File System Access API.
- Only file metadata is scanned — no file contents are read or sent anywhere.
- API keys are stored in browser memory only for the current session.
- The exported JSON is generated entirely client-side.

## Current Limitations

- Workflow generation is rule-based, not fully AI-model powered (Suggest/Simulate use the model for hints only).
- The exported JSON is n8n-inspired but not a direct n8n import format.
- File contents are never read; only metadata is used for routing.
