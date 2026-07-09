FROM node:22.23.1-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS builder

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
RUN npm i -g bun@1.3.14

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches/ patches/

# Copy package manifests for dependency resolution
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build
RUN cd packages/api && bun build src/index.ts src/scripts/worker.ts --outdir dist --target bun

# --- Production stage ---
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

WORKDIR /app

# Copy built output and node_modules
COPY --from=builder /app/packages/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

ENV NODE_ENV=production

CMD ["bun", "run", "dist/index.js"]
