FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV APP_ENV=simulation
ENV PORT=4173
ENV PERSISTENCE_MODE=memory

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@11.19.0 --activate \
  && pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm store prune

COPY beta-app ./beta-app
COPY data ./data
COPY ops ./ops

RUN mkdir -p /app/data/beta-evidence /app/ops \
  && chown -R node:node /app

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "beta-app/server.mjs"]
