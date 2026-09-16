FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY sidecar/package.json ./sidecar/package.json
RUN npm install
RUN npm run build -w @beercanlabs/factory-secrets-bind -w @beercanlabs/factory-doorman

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/secrets-bind/package.json ./packages/secrets-bind/package.json
COPY packages/doorman/package.json ./packages/doorman/package.json
COPY sidecar/package.json ./sidecar/package.json
RUN npm install --omit=dev
COPY --from=builder /app/packages/secrets-bind/dist ./packages/secrets-bind/dist
COPY --from=builder /app/packages/doorman/dist ./packages/doorman/dist
ENV PORT=8090
EXPOSE 8090
CMD ["node", "packages/doorman/dist/server.js"]
