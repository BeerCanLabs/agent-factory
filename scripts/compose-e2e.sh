#!/usr/bin/env bash
# End-to-end proof of the position paper on the Compose landing zone. Every check runs against the
# real stack: containers, networks, gatekeeper-egress, ledger. Exits non-zero on the first broken claim.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/landing-zones/compose"
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
DC+=(-f docker-compose.yml -f docker-compose.e2e.yml)
CP=http://localhost:8088
ADMIN="Authorization: Bearer dev-admin-token"
PASS=0

ok() { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m  %s\n' "$1"; }
die() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; "${DC[@]}" logs --tail 60 control-plane gatekeeper-egress >&2 || true; exit 1; }
api() { curl -sS -H "$ADMIN" -H 'content-type: application/json' "$@"; }
wait_run() { # runId -> terminal run JSON
  for _ in $(seq 1 120); do
    local r; r="$(api "$CP/api/v1/runs/$1")"
    case "$(jq -r .state <<<"$r")" in DONE | FAILED | TIMED_OUT | CANCELLED | BLOCKED_*) echo "$r"; return ;; esac
    sleep 0.5
  done
  die "run $1 did not finish"
}
cleanup() { [ "${KEEP:-0}" = 1 ] || "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== build and start"
(cd "$ROOT" && npm run build >/dev/null)
# COMPOSE_BUILDER (CI): build with the buildx builder that already holds these layers.
"${DC[@]}" --profile agents build -q ${COMPOSE_BUILDER:+--builder "$COMPOSE_BUILDER"}
"${DC[@]}" up -d --wait control-plane gatekeeper-egress gatekeeper-ingress mock-provider >/dev/null
ok "stack healthy"

echo "== identity"
[ "$(curl -s -o /dev/null -w '%{http_code}' $CP/api/v1/agents)" = 401 ] || die "unauthenticated catalog read"
forged="$(printf '{"alg":"RS256"}' | base64 | tr -d '=').$(printf '{"sub":"x","roles":["admin"]}' | base64 | tr -d '=').c2ln"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $forged" $CP/api/v1/agents)" = 401 ] || die "forged JWT accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer dev-gatekeeper-ingress-token' -d '{"agentId":"echo-agent","type":"llm"}' $CP/api/v1/ledger)" = 403 ] || die "operator wrote to the ledger"
ok "401 without token, 401 forged JWT, 403 operator->ledger"

echo "== network isolation (agents network is internal)"
RT=factory-agent-echo:dev
docker run --rm --network factory-agents --entrypoint node "$RT" -e \
  "fetch('https://api.anthropic.com',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))" \
  || die "agent network reached the internet"
docker run --rm --network factory-agents --entrypoint node "$RT" -e \
  "fetch('http://mock-provider:8080',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))" \
  || die "agent network reached the provider directly"
docker run --rm --network factory-agents --entrypoint node "$RT" -e \
  "fetch('http://gatekeeper-egress:8081/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
  || die "agent network cannot reach the gatekeeper-egress"
ok "internet and provider unreachable from agents; gatekeeper-egress reachable"

echo "== async run with a real agent container"
r="$(curl -sS -X POST -H 'x-factory-secret: e2e-echo-webhook' -H 'content-type: application/json' -d '{"hello":"compose"}' -w '\n%{http_code}' $CP/api/v1/hooks/echo-agent)"
[ "$(tail -1 <<<"$r")" = 202 ] || die "webhook did not return 202: $r"
run="$(wait_run "$(head -1 <<<"$r" | jq -r .runId)")"
[ "$(jq -r .state <<<"$run")" = DONE ] || die "echo run: $run"
[ "$(jq -c .result <<<"$run")" = '{"echo":{"hello":"compose"}}' ] || die "echo result: $(jq -c .result <<<"$run")"
# The run is DONE before its container is stopped and removed (finishRun), so allow cleanup a few seconds.
gone=""; for _ in $(seq 1 15); do
  [ -z "$(docker ps -aq --filter label=factory.run="$(jq -r .runId <<<"$run")")" ] && { gone=1; break; }; sleep 1
done
[ -n "$gone" ] || die "run container not removed within 15 s of DONE"
ok "webhook -> 202 -> container -> input/result via run token -> DONE -> container removed"

echo "== integration surfaces: WebSocket stream and event bus"
ws_out="$(cd "$ROOT" && node --input-type=module -e "
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:8088/api/v1/events?agent=echo-agent', { headers: { authorization: 'Bearer dev-admin-token' } });
const seen = [];
const t = setTimeout(() => { console.log(JSON.stringify(seen)); process.exit(1); }, 30000);
ws.on('message', async (d) => {
  const e = JSON.parse(String(d));
  if (e.kind === 'hello') {
    await fetch('http://localhost:8088/api/v1/hooks/echo-agent', { method: 'POST', headers: { 'x-factory-secret': 'e2e-echo-webhook', 'content-type': 'application/json' }, body: '{\"via\":\"ws\"}' });
    return;
  }
  if (e.kind === 'run') seen.push(e.run.state);
  if (e.kind === 'run' && e.run.state === 'DONE') { clearTimeout(t); console.log(JSON.stringify(seen)); process.exit(0); }
});
")" || die "WebSocket stream: $ws_out"
grep -q '"WORKING"' <<<"$ws_out" && grep -q '"DONE"' <<<"$ws_out" || die "WebSocket stream states: $ws_out"
sleep 2
"${DC[@]}" exec -T control-plane sh -c 'cat /data/events.ndjson' | jq -se 'map(select(.kind=="run" and .run.state=="DONE")) | length >= 2' >/dev/null || die "event bus missing run:DONE"
ok "WebSocket streamed $ws_out; bus file holds run outcomes"

echo "== egress policy (deny by default)"
[ "$(api -X POST -d '{"model":"test-big"}' -o /dev/null -w '%{http_code}' $CP/api/v1/agents/llm-summarizer/runs)" = 202 ] || die "run create"
denied="$(wait_run "$(api "$CP/api/v1/runs?agent=llm-summarizer" | jq -r '.[-1].runId')")"
[ "$(jq -r .state <<<"$denied")" = FAILED ] && grep -q 403 <<<"$(jq -r .error <<<"$denied")" || die "deny-by-default policy let a call through: $denied"
api -X PUT -d '{"routes":["models"],"models":["test-big","test-small"]}' $CP/api/v1/agents/llm-summarizer/policy >/dev/null
ok "no policy = no egress (403 at the gatekeeper-egress)"

echo "== cost vs quality harness"
out="$(cd "$ROOT" && node packages/bench/dist/cli.js --cartridge agents/examples/llm-summarizer --models test-big,test-small \
  --url $CP --token dev-admin-token --min-pass 0.9 --json /tmp/factory-bench.json 2>/dev/null)" || die "bench: $out"
grep -q '| test-big | 100% (2/2) |' <<<"$out" || die "bench matrix: $out"
grep -q '| test-small | 50% (1/2) |' <<<"$out" || die "bench matrix: $out"
grep -q 'Recommended: test-big' <<<"$out" || die "bench recommendation: $out"
cost="$(api "$CP/api/v1/ledger?agent=llm-summarizer" | jq '[.[] | select(.type=="llm") | .costUsd] | add')"
# Two priced calls per case through the factory model API: the request, then the turn with the tool result (GAP-174).
[ "$(jq -n "$cost == 0.096")" = true ] || die "ledger cost $cost != 0.096"
ok "matrix 100%/50%, recommends test-big; ledger holds \$$cost across 8 priced calls (tool round trips)"

echo "== budget cap"
spent="$(api "$CP/api/v1/ledger?agent=llm-summarizer" | jq '[.[] | select(.type=="llm") | .costUsd] | add')"
# A run makes two calls (0.0225 each on test-big): the cap is crossed by the second, which completes (bounded overshoot).
cap="$(jq -n "$spent + 0.03")"
api -X PUT -d "{\"routes\":[\"models\"],\"models\":[\"test-big\",\"test-small\"],\"budgetUsd\":{\"perDay\":$cap}}" $CP/api/v1/agents/llm-summarizer/policy >/dev/null
first="$(wait_run "$(api -X POST -d '{"model":"test-big","input":{"text":"one"}}' $CP/api/v1/agents/llm-summarizer/runs | jq -r .runId)")"
[ "$(jq -r .state <<<"$first")" = DONE ] || die "under-budget run: $(jq -c '{state,error}' <<<"$first")"
sleep 1
second_body="$(mktemp)"
second_code="$(api -X POST -d '{"model":"test-big","input":{"text":"two"}}' -o "$second_body" -w '%{http_code}' $CP/api/v1/agents/llm-summarizer/runs)"
[ "$second_code" = 402 ] && [ "$(jq -r .error "$second_body")" = budget_exceeded ] && [ "$(jq -r .window "$second_body")" = perDay ] || die "over-budget wake not refused: $second_code $(cat "$second_body")"
api "$CP/api/v1/ledger?agent=llm-summarizer" | jq -e '[.[] | select(.type=="budget.alert" and .action=="BUDGET_PERDAY_EXCEEDED")] | length == 1' >/dev/null || die "expected one budget.alert"
api "$CP/api/v1/ledger?agent=llm-summarizer" | jq -e '[.[] | select(.action=="WAKE_REFUSED_BUDGET_EXCEEDED")] | length == 1' >/dev/null || die "expected one wake refusal in the ledger"
ok "day cap \$$cap: crossing call completes (bounded overshoot), next wake refused 402 before any run starts, one budget.alert, one wake refusal"

echo "== kill switch"
api -X PUT -d '{"routes":["models"],"models":["test-big","test-small"]}' $CP/api/v1/agents/llm-summarizer/policy >/dev/null
api -X POST $CP/api/v1/agents/llm-summarizer/isolate >/dev/null
[ "$(api -X POST -o /dev/null -w '%{http_code}' $CP/api/v1/agents/llm-summarizer/runs)" = 409 ] || die "isolated agent accepted a run"
api -X POST $CP/api/v1/agents/llm-summarizer/resume >/dev/null
ok "isolate refuses new runs; resume restores"

echo "== a new agent runs on the shared runtime, created from a configuration (RT1, CF6)"
SOUL="You are Nova, a careful assistant. SOUL-MARKER-7731."
[ "$(api -X POST -d '{"repo":"https://github.com/beercanlabs/SM-fresh","commit":"1111111111111111111111111111111111111111","cartridge":{"id":"fresh","name":"fresh","memory":{"archetype":"personal-assistant"}}}' -o /dev/null -w '%{http_code}' $CP/api/v1/registry/agents)" = 422 ] || die "a new agent id was registered from a repository"
created="$(api -X POST -d "{\"id\":\"nova\",\"name\":\"Nova\",\"model\":\"test-small\",\"soul\":\"$SOUL\",\"memory\":{\"archetype\":\"personal-assistant\"}}" $CP/api/v1/agents)"
jq -e '.id == "nova" and .createdFrom == "configuration" and (.repo | test("agent-factory"))' >/dev/null <<<"$created" || die "create from configuration: $created"
api -X PUT -d '{"routes":["models"],"models":["test-small"]}' $CP/api/v1/agents/nova/policy >/dev/null
[ "$(api -X POST -d '{"content":"hello nova"}' -o /dev/null -w '%{http_code}' $CP/api/v1/agents/nova/conversation)" = 202 ] || die "turn to the new agent"
reply=""
for _ in $(seq 1 60); do
  reply="$(api "$CP/api/v1/agents/nova/replies" | jq -r '.replies[0].content // empty')"
  [ -n "$reply" ] && break
  sleep 1
done
[ "$reply" = "Tokens are counted." ] || die "the new agent did not answer through the shared runtime (got: '$reply')"
api "$CP/api/v1/ledger?agent=nova" | jq -e '[.[] | select(.type=="llm")] | length >= 1' >/dev/null || die "the new agent's model call is not in the ledger"
if api "$CP/api/v1/ledger" | grep -q 'SOUL-MARKER-7731'; then die "the soul is in the ledger"; fi
ok "a repository registration of a new id is refused; a new agent is created from a configuration, answers on the shared runtime image, its model call is priced in the ledger, its soul is not"

echo "== convert in place, runtime rollout, and activation smoke pass/fail (TSK-280, TSK-281, TSK-283, TSK-284)"
nova_dep="$(api -X POST $CP/api/v1/registry/agents/nova/deploy)"
jq -e '.smoke.ok == true and .deployedRuntime.image == "factory-agent-runtime:dev"' >/dev/null <<<"$nova_dep" || die "deploy nova: $nova_dep"

conv="$(api -X POST -d '{"soul":"You are Summarizer on the shared runtime.","memory":{"archetype":"purpose-built"},"model":"test-small"}' $CP/api/v1/agents/llm-summarizer/convert)"
jq -e '.createdFrom == "configuration" and .smoke.ok == true and .deployedRuntime.image == "factory-agent-runtime:dev"' >/dev/null <<<"$conv" || die "convert llm-summarizer: $conv"
api "$CP/api/v1/ledger?agent=llm-summarizer" | jq -e 'map(select(.action=="AGENT_CONVERTED")) | length >= 1' >/dev/null || die "AGENT_CONVERTED not in ledger"
api "$CP/api/v1/ledger?agent=llm-summarizer" | jq -e 'map(select(.action=="AGENT_DEPLOYED")) | length >= 1' >/dev/null || die "AGENT_DEPLOYED not in ledger"
[ -z "$("${DC[@]}" exec -T control-plane sh -c 'ls -A /data/mind/llm-summarizer 2>/dev/null || true')" ] || die "llm-summarizer mind directory not empty on purpose-built archetype"

rt_digest="$(docker image inspect factory-agent-runtime:dev --format '{{range .RepoDigests}}{{.}}{{end}}' 2>/dev/null || true)"
if [ -z "$rt_digest" ]; then
  rt_id="$(docker image inspect factory-agent-runtime:dev --format '{{.Id}}' | sed 's/sha256://')"
  rt_digest="factory-agent-runtime@sha256:$rt_id"
fi

rollout="$(api -X PUT -d "{\"repo\":\"https://github.com/BeerCanLabs/agent-factory\",\"image\":\"$rt_digest\",\"commit\":\"fedcba9876543210fedcba9876543210fedcba98\"}" $CP/api/v1/runtime)"
jq -e '.pin.commit == "fedcba9876543210fedcba9876543210fedcba98" and (.results | map(select(.status == "updated")) | length >= 2)' >/dev/null <<<"$rollout" || die "runtime rollout: $rollout"
api "$CP/api/v1/ledger" | jq -e 'map(select(.action=="SHARED_RUNTIME_UPDATED")) | length >= 1' >/dev/null || die "SHARED_RUNTIME_UPDATED not in ledger"

fail_digest="factory-agent-runtime@sha256:9999999999999999999999999999999999999999999999999999999999999999"
fail_rollout="$(api -X PUT -d "{\"repo\":\"https://github.com/BeerCanLabs/agent-factory\",\"image\":\"$fail_digest\",\"commit\":\"9999999999999999999999999999999999999999\"}" $CP/api/v1/runtime)"
jq -e '.results | map(select(.status == "smoke_failed")) | length >= 2' >/dev/null <<<"$fail_rollout" || die "forced smoke failure rollout: $fail_rollout"
agents_now="$(api "$CP/api/v1/agents")"
jq -e --arg img "$rt_digest" 'map(select(.id == "nova" or .id == "llm-summarizer") | select(.artifact == $img and .deployedRuntime.commit == "fedcba9876543210fedcba9876543210fedcba98")) | length == 2' >/dev/null <<<"$agents_now" || die "rollback agents state: $agents_now"
api "$CP/api/v1/ledger" | jq -e 'map(select(.action=="AGENT_SMOKE_FAILED")) | length >= 1' >/dev/null || die "AGENT_SMOKE_FAILED not in ledger"
api -X PUT -d "{\"repo\":\"https://github.com/BeerCanLabs/agent-factory\",\"image\":\"$rt_digest\",\"commit\":\"fedcba9876543210fedcba9876543210fedcba98\"}" $CP/api/v1/runtime >/dev/null
ok "convert in place, runtime rollout, and activation smoke pass/fail"

echo "== ledger integrity"
api "$CP/api/v1/ledger/verify" | jq -e '.ok == true' >/dev/null || die "ledger does not verify"
api "$CP/api/v1/ledger?agent=llm-summarizer" | jq -e 'all(.[]; (.prompt == null) and (.messages == null) and (.content == null))' >/dev/null || die "payload text in ledger"
if api "$CP/api/v1/ledger" | grep -q 'sk-e2e-provider-key'; then die "provider key in ledger"; fi
sleep 6
"${DC[@]}" restart control-plane >/dev/null
"${DC[@]}" up -d --wait control-plane >/dev/null
v="$(api "$CP/api/v1/ledger/verify")"
jq -e '.ok == true and .checkpointsChecked >= 1' >/dev/null <<<"$v" || die "after restart: $v"
ok "chain verifies, no prompts or keys stored, $(jq .checkpointsChecked <<<"$v") WORM checkpoint(s) anchor it across a restart"

echo "== tamper evidence"
"${DC[@]}" stop control-plane >/dev/null
docker run --rm -v agent-factory_factory-data:/data --entrypoint sh node:22-alpine -c \
  "sed -i '2s/\"actor\":\"[^\"]*\"/\"actor\":\"oidc:someone-else\"/' /data/ledger.jsonl"
"${DC[@]}" start control-plane >/dev/null
detected=""
for _ in $(seq 1 30); do
  detected="$("${DC[@]}" logs control-plane 2>&1 | grep -o 'ledger integrity failure at seq [0-9]*' | tail -1 || true)"
  [ -n "$detected" ] && break
  sleep 1
done
[ "$detected" = "ledger integrity failure at seq 2" ] || die "tampered ledger not detected (got: '${detected}')"
ok "edited ledger row -> control plane refuses to start (seq 2)"

echo
echo "PASS: $PASS checks"
