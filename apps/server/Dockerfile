# DSH Desktop Pro management server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t dsh-desktop-pro-server .
#
# Node 24 runs the TypeScript sources directly, so there is no build step.
# The workspace layout is kept on purpose: Node refuses to strip types inside
# node_modules, and the protocol package must resolve to its real path.
FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY dsh-runtime/package.json dsh-runtime/package.json
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/console apps/console
RUN pnpm install --frozen-lockfile --prod --filter "@dsh-desktop-pro/server..." \
  && addgroup -S dsh && adduser -S dsh -G dsh && mkdir -p /data && chown dsh:dsh /data
ENV NODE_ENV=production PORT=8080 DATABASE_URL=sqlite:/data/dsh-server.sqlite
USER dsh
WORKDIR /repo/apps/server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/main.ts"]
