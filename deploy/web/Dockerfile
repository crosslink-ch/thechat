# Build browser mode only; no native binary, API server, or credentials enter runtime.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack pnpm install --frozen-lockfile
COPY release-notes.json ./
COPY packages ./packages
# These are public build-time endpoints, not runtime env/Secrets. Keep CSP in sync.
ENV THECHAT_WEB_API_URL=https://thechat-api.pranexa.com
ENV THECHAT_WEB_WS_URL=wss://thechat-api.pranexa.com/ws
RUN corepack pnpm build:web

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
COPY deploy/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/packages/desktop/dist-web /usr/share/nginx/html
USER 101:101
EXPOSE 8080
# Skip image entrypoint scripts that edit /etc; this image supports a read-only root.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
