# Landing — minimaler Einstieg (nur express). Eigener Build-Kontext (apps/landing).
# Reproduzierbar: npm ci gegen das standalone Landing-Lockfile (ein fehlgeschlagenes
# Install bricht den Build hart ab — kein "|| true").
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
