#!/usr/bin/env bash
# Deploy the factory to the BeerCanLabs AWS account and run the definition-of-done checks.
# Every AWS/terraform call goes through scripts/bcl-aws (isolated config + account preflight).
#
#   export BCL_AWS_ACCOUNT_ID=<id>          # the BeerCanLabs account
#   export FACTORY_CERT_ARN=<acm arn>       # HTTPS for the control plane
#   export FACTORY_DOMAIN=<name on the cert> # e.g. factory.beercanlabs.com, CNAME'd to the ALB
#   ./scripts/aws-deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BCL="$ROOT/scripts/bcl-aws"
LZ="$ROOT/landing-zones/aws"
REGION="${AWS_REGION:-us-east-1}"
TAG="${FACTORY_TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"
: "${BCL_AWS_ACCOUNT_ID:?set BCL_AWS_ACCOUNT_ID}" "${FACTORY_CERT_ARN:?set FACTORY_CERT_ARN}" "${FACTORY_DOMAIN:?set FACTORY_DOMAIN}"
export TF_VAR_certificate_arn="$FACTORY_CERT_ARN" TF_VAR_aws_region="$REGION"
REGISTRY="$BCL_AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

say() { printf '\n== %s\n' "$1"; }

say "bootstrap (state bucket, CI deploy role)"
"$BCL" terraform -chdir="$LZ/bootstrap" init -input=false >/dev/null
"$BCL" terraform -chdir="$LZ/bootstrap" apply -input=false -auto-approve
STATE_BUCKET="$("$BCL" terraform -chdir="$LZ/bootstrap" output -raw state_bucket)"

say "landing zone: base infrastructure and registries"
"$BCL" terraform -chdir="$LZ" init -input=false -reconfigure \
  -backend-config="bucket=$STATE_BUCKET" -backend-config="key=agent-factory/landing-zone.tfstate" \
  -backend-config="region=$REGION" -backend-config="use_lockfile=true" -backend-config="encrypt=true" >/dev/null
AGENTS_JSON="$(printf '{"echo-agent":{"image":"%s/factory-agent-echo-agent:%s","secrets":["ECHO_WEBHOOK_SECRET"]},"llm-summarizer":{"image":"%s/factory-agent-llm-summarizer:%s"}}' "$REGISTRY" "$TAG" "$REGISTRY" "$TAG")"
export TF_VAR_agents="$AGENTS_JSON"
export TF_VAR_control_plane_image="$REGISTRY/factory-control-plane:$TAG"
export TF_VAR_gateway_image="$REGISTRY/factory-gateway:$TAG"
export TF_VAR_doorman_image="$REGISTRY/factory-doorman:$TAG"
"$BCL" terraform -chdir="$LZ" apply -input=false -auto-approve

say "images ($TAG)"
"$BCL" sh -c "aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY" >/dev/null
build() { docker build --no-cache --platform linux/amd64 -q -f "$1" ${3:+--build-arg CARTRIDGE=$3} -t "$REGISTRY/$2:$TAG" "$ROOT" >/dev/null && docker push -q "$REGISTRY/$2:$TAG" >/dev/null && echo "  $2:$TAG"; }
build "$ROOT/packages/control-plane/Dockerfile" factory-control-plane
build "$ROOT/packages/gateway/Dockerfile" factory-gateway
build "$ROOT/packages/doorman/Dockerfile" factory-doorman
build "$ROOT/runtimes/generic/Dockerfile" factory-agent-echo-agent examples/echo-agent
build "$ROOT/runtimes/generic/Dockerfile" factory-agent-llm-summarizer examples/llm-summarizer

say "landing zone: services"
export TF_VAR_control_plane_image="$REGISTRY/factory-control-plane:$TAG" \
  TF_VAR_gateway_image="$REGISTRY/factory-gateway:$TAG" TF_VAR_doorman_image="$REGISTRY/factory-doorman:$TAG"
"$BCL" terraform -chdir="$LZ" apply -input=false -auto-approve
"$BCL" aws ecs wait services-stable --cluster "factory-prod" --services control-plane gateway doorman --region "$REGION"

say "definition of done"
ALB_DNS=$("$BCL" terraform -chdir="$LZ" output -raw alb_dns_name)
ADMIN="$("$BCL" aws secretsmanager get-secret-value --secret-id factory/prod/FACTORY_TOKEN --query SecretString --output text --region "$REGION")"
CP="https://$FACTORY_DOMAIN"
api() { curl --resolve $FACTORY_DOMAIN:443:$(dig +short "$ALB_DNS" | head -n1) --resolve $FACTORY_DOMAIN:80:$(dig +short "$ALB_DNS" | head -n1) -sS --fail-with-body -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' "$@"; }
[ "$(curl --resolve $FACTORY_DOMAIN:443:$(dig +short "$ALB_DNS" | head -n1) --resolve $FACTORY_DOMAIN:80:$(dig +short "$ALB_DNS" | head -n1) -s -o /dev/null -w '%{http_code}' "http://$FACTORY_DOMAIN/healthz")" = 301 ] && echo "  ok  plain HTTP redirects"
curl --resolve $FACTORY_DOMAIN:443:$(dig +short "$ALB_DNS" | head -n1) --resolve $FACTORY_DOMAIN:80:$(dig +short "$ALB_DNS" | head -n1) -sS --fail "$CP/healthz" >/dev/null && echo "  ok  HTTPS health"
[ "$(curl --resolve $FACTORY_DOMAIN:443:$(dig +short "$ALB_DNS" | head -n1) --resolve $FACTORY_DOMAIN:80:$(dig +short "$ALB_DNS" | head -n1) -s -o /dev/null -w '%{http_code}' "$CP/api/v1/agents")" = 401 ] && echo "  ok  unauthenticated 401"
rid="$(api -X POST -d '{"input":{"hello":"aws"}}' "$CP/api/v1/agents/echo-agent/runs" | jq -r .runId)"
for _ in $(seq 1 120); do st="$(api "$CP/api/v1/runs/$rid" | jq -r .state)"; case "$st" in DONE | FAILED | TIMED_OUT) break ;; esac; sleep 2; done
[ "$st" = DONE ] && echo "  ok  echo run DONE from a private subnet with no NAT" || { echo "  FAIL echo run: $st"; exit 1; }
sleep 70
api "$CP/api/v1/ledger/verify" | jq -e '.ok and .checkpointsChecked >= 1 and .worm' >/dev/null && echo "  ok  ledger verifies against S3 Object Lock checkpoints"
echo
echo "Set provider keys (only the gateway can read them), prices, and per-agent policy to enable LLM egress:"
"$BCL" terraform -chdir="$LZ" output provider_secrets
