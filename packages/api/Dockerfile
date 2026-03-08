FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate
RUN npm i -g bun

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy package manifests for dependency resolution
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build
RUN cd packages/api && bun build src/index.ts --outdir dist --target bun

# --- Production stage ---
FROM oven/bun:1-slim

WORKDIR /app

# Copy built output and node_modules
COPY --from=builder /app/packages/api/dist/index.js ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

ENV NODE_ENV=production

CMD ["bun", "run", "index.js"]
