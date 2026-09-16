FROM node:22-alpine
WORKDIR /app
COPY packages/hydrate/package.json ./packages/hydrate/package.json
COPY packages/hydrate/dist ./packages/hydrate/dist
COPY runtimes/generic/start.sh /runtime/start.sh
RUN chmod +x /runtime/start.sh
ENTRYPOINT ["/runtime/start.sh"]
