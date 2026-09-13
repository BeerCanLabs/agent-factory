#!/bin/sh
set -e

echo "[OpenClaw Runtime] Starting OpenClaw Code Execution Engine..."
export AGENT_ID="${AGENT_ID:-openclaw-builder-01}"
export AGENT_NAME="${AGENT_NAME:-OpenClaw-Builder}"
export AGENT_SECTOR="${AGENT_SECTOR:-sector-ops}"
export AGENT_ROLE="${AGENT_ROLE:-Full-Stack Code Synthesis & Sandbox Worker}"
export AGENT_MODEL="${AGENT_MODEL:-claude-3-7-sonnet}"
export AGENT_PROVIDER="${AGENT_PROVIDER:-gcp-cloud-run}"

# Launch the Garrison Sidecar which in turn manages and monitors the OpenClaw worker process
exec node /app/sidecar/dist/index.js
