FROM node:20-bookworm-slim

WORKDIR /app

ARG APP_VERSION=1.1.0
ARG APP_BRANCH=local
ARG APP_COMMIT=unknown

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV APP_VERSION=${APP_VERSION}
ENV APP_BRANCH=${APP_BRANCH}
ENV APP_COMMIT=${APP_COMMIT}

LABEL org.opencontainers.image.title="Simple Issue Tracker"
LABEL org.opencontainers.image.description="Self-hosted issue-and-resolution log for church production teams."
LABEL org.opencontainers.image.source="https://github.com/thedinz/SIT"

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
