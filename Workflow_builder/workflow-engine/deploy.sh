#!/bin/bash
# deploy.sh — Build and deploy the workflow engine
# Run: chmod +x deploy.sh && ./deploy.sh

set -e  # Exit on any error

echo ""
echo "🔶 Workflow Engine — Deploy Script"
echo "─────────────────────────────────"

# ── Check Docker is installed ──────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "❌ Docker not found. Install it from https://docker.com/get-started"
  exit 1
fi

if ! command -v docker compose &> /dev/null; then
  echo "❌ Docker Compose not found. Make sure Docker Desktop is installed."
  exit 1
fi

# ── Build and start ────────────────────────────────────────────────────────────
echo ""
echo "📦 Building Docker image..."
docker compose build

echo ""
echo "🚀 Starting containers..."
docker compose up -d

echo ""
echo "✅ Done! Workflow Engine is running."
echo ""
echo "   API:    http://localhost:3001"
echo "   Health: http://localhost:3001/api/health"
echo "   Logs:   docker compose logs -f"
echo ""

# ── Save credentials if .env exists ───────────────────────────────────────────
if [ -f ".env" ]; then
  echo "🔑 Found .env — saving credentials to engine..."
  source .env
  curl -s -X POST http://localhost:3001/api/credentials \
    -H "Content-Type: application/json" \
    -d "{
      \"anthropicApiKey\": \"${ANTHROPIC_API_KEY:-}\",
      \"slackToken\":      \"${SLACK_TOKEN:-}\",
      \"gmailToken\":      \"${GMAIL_TOKEN:-}\"
    }" > /dev/null
  echo "   Credentials saved ✓"
fi

echo ""
echo "─────────────────────────────────"
echo "To stop:    docker compose down"
echo "To restart: docker compose restart"
echo "To update:  git pull && ./deploy.sh"
echo ""
