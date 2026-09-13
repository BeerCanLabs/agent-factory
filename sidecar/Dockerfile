FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

ENV PORT=9090
ENV GARRISON_URL=http://localhost:3001
EXPOSE 9090

ENTRYPOINT ["node", "dist/index.js"]
