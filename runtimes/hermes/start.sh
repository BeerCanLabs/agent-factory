#!/bin/sh
set -e

echo "[Hermes Runtime] Starting Hermes Cognitive Engine..."
export AGENT_ID="${AGENT_ID:-hermes-researcher-01}"
export AGENT_NAME="${AGENT_NAME:-Hermes-Researcher}"
export AGENT_SECTOR="${AGENT_SECTOR:-sector-eng}"
export AGENT_ROLE="${AGENT_ROLE:-Autonomous Research & Synthesis Agent}"
export AGENT_MODEL="${AGENT_MODEL:-hermes-3-llama-3.1-70b}"
export AGENT_PROVIDER="${AGENT_PROVIDER:-aws-ecs}"

# Sidecar process only. Pair with a worker container; do not treat this as the agent PID 1.
exec node /app/sidecar/dist/index.js
