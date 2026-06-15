# App — Frontend + Backend + KI-Agenten.
# Monorepo-Build (Build-Kontext = Repo-Root, in Coolify base_directory "/"):
# server.js importiert aus packages/graph-client (datarooms.js + index-store.js mit `pg`).
FROM node:22-alpine
WORKDIR /app
COPY apps/app/package.json ./apps/app/package.json
COPY packages/graph-client/package.json ./packages/graph-client/package.json
RUN cd apps/app && npm install --omit=dev || true
RUN cd packages/graph-client && npm install --omit=dev || true
COPY apps/app ./apps/app
COPY packages ./packages
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/app/src/server.js"]
