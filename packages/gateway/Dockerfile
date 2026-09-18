FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-auth -w @beercanlabs/factory-ledger -w @beercanlabs/factory-secrets-bind -w @beercanlabs/factory-telemetry -w @beercanlabs/factory-gateway

FROM node:22-alpine
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/ledger/package.json ./packages/ledger/package.json
COPY packages/secrets-bind/package.json ./packages/secrets-bind/package.json
COPY packages/telemetry/package.json ./packages/telemetry/package.json
COPY packages/gateway/package.json ./packages/gateway/package.json
RUN npm install --omit=dev -w @beercanlabs/factory-gateway
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder /app/packages/ledger/dist ./packages/ledger/dist
COPY --from=builder /app/packages/secrets-bind/dist ./packages/secrets-bind/dist
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "packages/gateway/dist/main.js"]
