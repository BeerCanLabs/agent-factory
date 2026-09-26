FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-console

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/console/package.json ./packages/console/package.json
RUN npm install --omit=dev -w @beercanlabs/factory-console && npm install -g tsx
COPY --from=builder /app/packages/console/dist ./packages/console/dist
COPY packages/console/server.ts ./packages/console/server.ts

WORKDIR /app/packages/console
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["tsx", "server.ts"]
