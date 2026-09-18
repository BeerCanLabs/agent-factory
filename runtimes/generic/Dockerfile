# Generic agent runtime: the factory shim wraps a cartridge's worker.
#   docker build -f runtimes/generic/Dockerfile --build-arg CARTRIDGE=examples/echo-agent -t factory-agent-echo .
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-hydrate

FROM node:22-alpine
ARG CARTRIDGE=examples/echo-agent
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY --from=builder /app/packages/hydrate/package.json ./packages/hydrate/package.json
COPY --from=builder /app/packages/hydrate/dist ./packages/hydrate/dist
COPY agents/${CARTRIDGE}/worker.mjs /app/worker.mjs
ENV MEMORY_DIR=/tmp/mind
USER node
ENTRYPOINT ["node", "/app/packages/hydrate/dist/shim.js", "--"]
CMD ["node", "/app/worker.mjs"]
