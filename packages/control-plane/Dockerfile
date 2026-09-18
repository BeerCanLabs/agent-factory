FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-contract \
  -w @beercanlabs/factory-auth \
  -w @beercanlabs/factory-secrets-bind \
  -w @beercanlabs/factory-hydrate \
  -w @beercanlabs/factory-ledger \
  -w @beercanlabs/factory-telemetry \
  -w @beercanlabs/factory-control-plane

FROM node:22-alpine
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json ./packages/contract/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/secrets-bind/package.json ./packages/secrets-bind/package.json
COPY packages/hydrate/package.json ./packages/hydrate/package.json
COPY packages/ledger/package.json ./packages/ledger/package.json
COPY packages/telemetry/package.json ./packages/telemetry/package.json
COPY packages/control-plane/package.json ./packages/control-plane/package.json
RUN npm install --omit=dev -w @beercanlabs/factory-control-plane
COPY --from=builder /app/packages/contract/dist ./packages/contract/dist
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder /app/packages/secrets-bind/dist ./packages/secrets-bind/dist
COPY --from=builder /app/packages/hydrate/dist ./packages/hydrate/dist
COPY --from=builder /app/packages/ledger/dist ./packages/ledger/dist
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY agents ./agents
ENV PORT=8088
ENV AGENTS_ROOT=/app/agents
EXPOSE 8088
CMD ["node", "packages/control-plane/dist/index.js"]
