FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-auth -w @beercanlabs/factory-ledger -w @beercanlabs/factory-budget -w @beercanlabs/factory-bouncer -w @beercanlabs/factory-secrets-bind -w @beercanlabs/factory-telemetry -w @beercanlabs/factory-inspector -w @beercanlabs/factory-gatekeeper-egress

FROM node:22-alpine
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/ledger/package.json ./packages/ledger/package.json
COPY packages/budget/package.json ./packages/budget/package.json
COPY packages/bouncer/package.json ./packages/bouncer/package.json
COPY packages/secrets-bind/package.json ./packages/secrets-bind/package.json
COPY packages/telemetry/package.json ./packages/telemetry/package.json
COPY packages/inspector/package.json ./packages/inspector/package.json
COPY packages/gatekeeper-egress/package.json ./packages/gatekeeper-egress/package.json
RUN npm install --omit=dev -w @beercanlabs/factory-gatekeeper-egress
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder /app/packages/ledger/dist ./packages/ledger/dist
COPY --from=builder /app/packages/budget/dist ./packages/budget/dist
COPY --from=builder /app/packages/bouncer/dist ./packages/bouncer/dist
COPY --from=builder /app/packages/secrets-bind/dist ./packages/secrets-bind/dist
COPY --from=builder /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder /app/packages/inspector/dist ./packages/inspector/dist
COPY --from=builder /app/packages/gatekeeper-egress/dist ./packages/gatekeeper-egress/dist
ENV PORT=8081
EXPOSE 8081
USER node
CMD ["node", "packages/gatekeeper-egress/dist/main.js"]
