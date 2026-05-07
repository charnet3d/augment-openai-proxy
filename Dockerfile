# syntax=docker/dockerfile:1
# ── deps stage: install all dependencies (includes tsx devDep) ──────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

# ── runtime stage: copy deps + source, run via tsx ──────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Install the Augment CLI so session-based auth (auggie login) works inside
# the container when the ~/.augment directory is mounted.
RUN npm install -g @augmentcode/auggie

# Copy pre-installed node_modules from the deps stage (avoids a second npm ci).
COPY --from=deps /app/node_modules ./node_modules

# Copy source — changes here do NOT invalidate the expensive deps layer.
COPY package*.json tsconfig.json ./
COPY src/ ./src/

EXPOSE 7888

CMD ["npx", "tsx", "src/index.ts"]
