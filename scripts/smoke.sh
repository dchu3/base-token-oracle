#!/usr/bin/env bash
# Local smoke test for a running base-token-oracle instance.
#
# Assumes the service is listening on http://localhost:8080 unless ORACLE_URL
# is set. Exercises only the free + unauthenticated paths; the paid flow
# (signing + retry with X-PAYMENT) requires a funded wallet and must be
# verified manually after first deploy — see README "Production Deployment".

set -uo pipefail

ORACLE_URL="${ORACLE_URL:-http://localhost:8080}"

pass=0
fail=0

ok()   { echo "  OK   $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL $*"; fail=$((fail+1)); }

echo "Smoke-testing ${ORACLE_URL}"

# 1) /healthz should return {"ok":true}
echo "[1/3] GET /healthz"
body=$(curl -fsS --max-time 5 "${ORACLE_URL}/healthz" || true)
if echo "$body" | grep -q '"ok":true'; then
  ok "/healthz reports ok:true"
else
  bad "/healthz missing ok:true — got: ${body:-<empty>}"
fi

# 2) /llms.txt should contain the service banner
echo "[2/3] GET /llms.txt"
body=$(curl -fsS --max-time 5 "${ORACLE_URL}/llms.txt" || true)
if echo "$body" | grep -q '^# base-token-oracle'; then
  ok "/llms.txt contains '# base-token-oracle'"
else
  bad "/llms.txt banner missing"
fi

# 3) A paid endpoint (without X-PAYMENT) must return 402 with PAYMENT-REQUIRED header.
# Using an arbitrary token address (USDC-on-Ethereum) purely to force a 402 — we
# never sign or retry, so no funds are required.
addr="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
path="/api/v1/x402/base/token/${addr}/market"
echo "[3/3] GET ${path} (expecting 402)"

headers_file="./.smoke-headers.$$"
trap 'rm -f "$headers_file"' EXIT

status=$(curl -sS -o /dev/null -D "$headers_file" -w '%{http_code}' \
  --max-time 10 "${ORACLE_URL}${path}" || echo "000")

if [ "$status" = "402" ]; then
  ok "paid route returned HTTP 402"
else
  bad "paid route expected 402, got ${status}"
fi

if grep -qi '^payment-required:' "$headers_file"; then
  ok "PAYMENT-REQUIRED header present"
else
  bad "PAYMENT-REQUIRED header missing"
  echo "    (headers seen:)"
  sed 's/^/      /' "$headers_file"
fi

echo
echo "Passed: ${pass}  Failed: ${fail}"
if [ "$fail" -gt 0 ]; then
  echo "SMOKE: FAIL"
  exit 1
fi
echo "SMOKE: OK"
echo
echo "Note: the real paid flow (sign → X-PAYMENT retry → 200) is NOT covered"
echo "here. It requires a funded Base-mainnet wallet and incurs real USDC cost."
echo "Verify manually with \`awal x402 pay\` after deploying — see README."
