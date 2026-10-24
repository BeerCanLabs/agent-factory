# The shared agent runtime (DESIGN_AUTHORITY.md §6.18 RT1). One image runs every agent created from a configuration;
# the factory pins its version, and an agent's soul, memory settings and adopted skills come from its configuration at
# each wake. The factory's shim wraps the program exactly as it wraps a cartridge worker (hydrate the notebook, point
# model SDKs at the gatekeeper-egress, heartbeat, replicate the notebook, report a crash): the notebook is the agent's
# own, in its own container, and the factory never opens it. The adopted skills are the factory's skills layer at
# /opt/factory/skills (SK4).
#   docker build -f runtimes/agent-runtime/Dockerfile -t factory-agent-runtime .     (from the repository root)
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-hydrate

FROM node:22-alpine
RUN apk add --no-cache aws-cli python3
WORKDIR /app
COPY --from=builder /app/packages/hydrate/package.json ./packages/hydrate/package.json
COPY --from=builder /app/packages/hydrate/dist ./packages/hydrate/dist
COPY runtimes/agent-runtime/runtime ./runtime
COPY runtimes/agent-runtime/memory ./memory
ENV MEMORY_DIR=/tmp/mind SKILLS_DIR=/opt/factory/skills PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER node
ENTRYPOINT ["node", "/app/packages/hydrate/dist/shim.js", "--"]
CMD ["python3", "-m", "runtime"]
