#!/usr/bin/env bash
# Locksmith Function
# Usage: ./scripts/locksmith.sh <secret_name> <secret_value>
# Securely injects a secret into the AWS Secrets Manager for the Factory.

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <secret_name> <secret_value>"
  exit 1
fi

SECRET_NAME="$1"
SECRET_VALUE="$2"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BCL="$ROOT/scripts/bcl-aws"

FULL_SECRET_NAME="factory/prod/$SECRET_NAME"

echo "[Locksmith] Securing $FULL_SECRET_NAME..."

# Try to update the existing secret, or create it if it doesn't exist
"$BCL" aws secretsmanager put-secret-value \
  --secret-id "$FULL_SECRET_NAME" \
  --secret-string "$SECRET_VALUE" \
  >/dev/null 2>&1 || \
"$BCL" aws secretsmanager create-secret \
  --name "$FULL_SECRET_NAME" \
  --secret-string "$SECRET_VALUE" \
  >/dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "[Locksmith] Success: Secret '$SECRET_NAME' has been securely vaulted."
else
  echo "[Locksmith] Error: Failed to vault secret '$SECRET_NAME'."
  exit 1
fi
