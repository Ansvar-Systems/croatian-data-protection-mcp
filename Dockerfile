# ─────────────────────────────────────────────────────────────────────────────
# Croatian Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t croatian-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 croatian-data-protection-mcp
#
# The image expects a pre-built database at /app/data/azop.db.
# Override with AZOP_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native modules ---
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for better-sqlite3 native binding (postinstall)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Full install — allows postinstall to build native bindings
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV AZOP_DB_PATH=/app/data/azop.db

# Reuse builder's node_modules (preserves built native bindings)
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY package.json package-lock.json* ./

# Database: workflow provisions data/database.db; Dockerfile renames to azop.db at COPY time
COPY data/database.db data/azop.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
