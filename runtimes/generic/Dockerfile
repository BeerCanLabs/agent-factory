# Generic agent runtime: the factory shim wraps any worker command.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-hydrate

FROM node:22-alpine
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY --from=builder /app/packages/hydrate/package.json ./packages/hydrate/package.json
COPY --from=builder /app/packages/hydrate/dist ./packages/hydrate/dist
COPY agents/examples/echo-agent/worker.mjs /app/worker.mjs
ENV MEMORY_DIR=/mind
ENV MEMORY_PREFIX=echo-agent
USER node
ENTRYPOINT ["node", "/app/packages/hydrate/dist/shim.js", "--"]
CMD ["node", "/app/worker.mjs"]
