# House Staff Python cartridge runtime (DESIGN_AUTHORITY.md §5 TSK-341, §6.18).
# Builds a standalone image for one of the three House Staff cartridges
# (factory-manager, agent-builder, personal-trainer) located under agents/staff/${STAFF_ID}.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm install
RUN npm run build -w @beercanlabs/factory-hydrate

FROM node:22-alpine
RUN apk add --no-cache aws-cli python3
ARG STAFF_ID
WORKDIR /app
COPY --from=builder /app/packages/hydrate/package.json ./packages/hydrate/package.json
COPY --from=builder /app/packages/hydrate/dist ./packages/hydrate/dist
COPY agents/staff/${STAFF_ID} /app/staff
WORKDIR /app/staff
ENV MEMORY_DIR=/tmp/mind PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER node
ENTRYPOINT ["node", "/app/packages/hydrate/dist/shim.js", "--"]
CMD ["python3", "agent.py"]
