FROM node:22-alpine
RUN apk add --no-cache aws-cli
WORKDIR /app
COPY packages/hydrate/package.json ./packages/hydrate/package.json
COPY packages/hydrate/dist ./packages/hydrate/dist
COPY runtimes/generic/start.sh /runtime/start.sh
COPY agents/examples/echo-agent/worker.mjs /app/worker.mjs
RUN chmod +x /runtime/start.sh
ENV MEMORY_DIR=/mind
ENV MEMORY_PREFIX=echo-agent
ENTRYPOINT ["/runtime/start.sh"]
CMD ["node", "/app/worker.mjs"]
