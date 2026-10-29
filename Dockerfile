FROM node:24.22.2-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node package.json package-lock.json ./
USER node
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src/ ./src/

EXPOSE 3010
STOPSIGNAL SIGTERM
CMD ["node", "src/server.js"]
