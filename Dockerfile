FROM node:24.22.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /run/ollama-relay && chown node:node /app /run/ollama-relay
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src/ ./src/
COPY --chown=node:node sql/002-ai.sql ./sql/002-ai.sql

EXPOSE 3010
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
