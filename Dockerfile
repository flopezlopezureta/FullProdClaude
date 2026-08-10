# Stage 1: Build frontend
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Increase network timeout for stability
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retry-mintimeout 100000 && \
    npm config set fetch-retries 5

# Install all dependencies using ci for reliability
RUN npm ci

# Copy source
COPY . .

# Build the Vite frontend with memory limits to prevent OOM kills on smaller VPS hosts.
# Bumped from 512 to 1024 — the Service Worker precache-manifest generation step (Workbox)
# added 2026-08-09 needs more headroom than the base Vite build alone did.
RUN NODE_OPTIONS="--max-old-space-size=1024" npm run build

# Stage 2: Production runtime
FROM node:22-alpine AS runner

# Set timezone to Chile
RUN apk add --no-cache tzdata
ENV TZ=America/Santiago

WORKDIR /app

# Copy package files and install only production deps
COPY package*.json ./
RUN npm config set fetch-retry-maxtimeout 600000 && \
    npm config set fetch-retry-mintimeout 100000 && \
    npm config set fetch-retries 5 && \
    npm ci --omit=dev

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server and all backend files
COPY server.js .
COPY db.js .
COPY routes ./routes
COPY middleware ./middleware
COPY services ./services
COPY utils ./utils
COPY scripts ./scripts
COPY .env* ./

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
