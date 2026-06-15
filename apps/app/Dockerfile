# App — Frontend + Backend + KI-Agenten.
# Monorepo-Build (Build-Kontext = Repo-Root, Coolify base_directory "/"):
# server.js importiert aus packages/graph-client (datarooms.js + index-store.js mit `pg`).
# Reproduzierbar: npm ci gegen das committete Root-Lockfile (Workspaces). Deps werden zur
# Root-node_modules gehoistet -> die relativen packages/graph-client-Importe finden sie dort.
FROM node:22-alpine
WORKDIR /app
# Erst Manifeste + Lock (Layer-Caching). Alle Workspace-Manifeste nötig, da das
# Root-Lockfile sie referenziert; npm ci bricht sonst ab.
COPY package.json package-lock.json ./
COPY apps/app/package.json ./apps/app/package.json
COPY apps/landing/package.json ./apps/landing/package.json
COPY packages/graph-client/package.json ./packages/graph-client/package.json
RUN npm ci --omit=dev
COPY apps/app ./apps/app
COPY packages ./packages
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/app/src/server.js"]
