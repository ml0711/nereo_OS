# App — Frontend + Backend + KI-Agenten
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# COPY package-lock.json ./
RUN npm install --omit=dev || true
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
