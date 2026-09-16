FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY sidecar ./sidecar
RUN npm install
RUN npm run build -w @beercanlabs/factory-ledger -w @beercanlabs/factory-sidecar

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY sidecar/package.json ./sidecar/package.json
RUN npm install --omit=dev
COPY --from=builder /app/packages/ledger/dist ./packages/ledger/dist
COPY --from=builder /app/sidecar/dist ./sidecar/dist
ENV PORT=9090
EXPOSE 9090
CMD ["node", "sidecar/dist/index.js"]
