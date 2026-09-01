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
RUN cd packages/api && bun build src/index.ts src/scripts/worker.ts --outdir dist --target bun --external sharp

# --- Production stage ---
FROM oven/bun:1-slim

WORKDIR /app/packages/api

# Keep the package-level dependency links next to the bundle and the pnpm
# virtual store at its original workspace-relative path. Native dependencies
# such as sharp can then resolve their platform package at runtime.
COPY --from=builder /app/packages/api/dist ./dist
COPY --from=builder /app/packages/api/package.json ./package.json
COPY --from=builder /app/packages/api/node_modules ./node_modules
COPY --from=builder /app/node_modules /app/node_modules

EXPOSE 3000

ENV NODE_ENV=production

CMD ["bun", "run", "dist/index.js"]
