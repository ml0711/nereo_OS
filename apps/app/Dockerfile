# App — Frontend + Backend + KI-Agenten.
# WICHTIG: Monorepo-Build (Build-Kontext = Repo-Root, in Coolify base_directory "/"),
# damit packages/graph-client mitkommt — src/server.js importiert daraus.
FROM node:22-alpine
WORKDIR /app
COPY apps/app/package.json ./apps/app/package.json
RUN cd apps/app && npm install --omit=dev || true
COPY apps/app ./apps/app
COPY packages ./packages
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/app/src/server.js"]
