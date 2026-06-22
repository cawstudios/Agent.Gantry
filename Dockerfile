FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY . .

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV GANTRY_HOME=/home/node/gantry
ENV PATH=/app/node_modules/.bin:/usr/local/bin:$PATH

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    dumb-init \
    git \
    openssh-client \
    procps \
    wget \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/.claude ./.claude
COPY --from=builder --chown=node:node /app/docker-compose.yml ./docker-compose.yml
COPY --from=builder --chown=node:node /app/ops ./ops

RUN chmod +x /app/dist/cli/index.js \
  && ln -s /app/dist/cli/index.js /usr/local/bin/gantry \
  && mkdir -p /home/node/gantry \
  && chown -R node:node /home/node/gantry /app

USER node

VOLUME ["/home/node/gantry"]

EXPOSE 8787

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "-e", "import('/app/dist/index.js').then(async (runtime) => { await runtime.startGantryRuntime(); await new Promise(() => {}); }).catch((error) => { console.error(error); process.exit(1); })"]
