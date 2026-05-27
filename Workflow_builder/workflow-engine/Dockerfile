# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only package files first (Docker cache layer — reinstall only when these change)
COPY package*.json ./
RUN npm install --omit=dev

# ── Stage 2: Runtime image ─────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Add a non-root user for security
RUN addgroup -S workflow && adduser -S workflow -G workflow

# Copy installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create persistent storage directories and give ownership to our user
RUN mkdir -p storage/workflows storage/logs \
    && chown -R workflow:workflow /app

# Switch to non-root user
USER workflow

# Expose the API port
EXPOSE 3001

# Health check — Docker will restart container if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Start the server
CMD ["node", "server.js"]
