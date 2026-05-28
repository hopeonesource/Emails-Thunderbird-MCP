#!/usr/bin/env bash
set -u

PROFILE="${HOS_AWS_PROFILE:-HopeOneSource-Dev}"
COMPAT_PROFILE="${HOS_COMPAT_AWS_PROFILE:-HOP42-Sandbox-Developer}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

failures=0

ok() {
  printf 'OK: %s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

have() {
  command -v "$1" >/dev/null 2>&1
}

secret_groups=(
  "Salesforce JWT|hope1source/dev/salesforce/jwt|hope1source/hop43/salesforce-jwt"
  "Google service account|hope1source/dev/google/service-account|hope1source/hop43/google-service-account"
)

printf 'HopeOneSource team dev doctor\n'
printf 'Blast radius: Level 1 read-only checks. This script verifies tools, AWS identity, and secret read access. It does not write external data.\n\n'

if have node; then ok "node $(node --version)"; else fail "node is not installed"; fi
if have npm; then ok "npm $(npm --version)"; else fail "npm is not installed"; fi
if have aws; then ok "aws cli found"; else fail "aws cli is not installed"; fi

if [ ! -f package.json ]; then
  warn "package.json not found in current directory; run from the repo root"
elif [ ! -f package-lock.json ]; then
  warn "package-lock.json not found; this is expected for repos that do not commit a lockfile"
fi

if have aws; then
  profiles="$(aws configure list-profiles 2>/dev/null || true)"
  if printf '%s\n' "$profiles" | grep -qx "$PROFILE"; then
    ok "AWS profile '$PROFILE' exists"
  elif printf '%s\n' "$profiles" | grep -qx "$COMPAT_PROFILE"; then
    warn "AWS profile '$PROFILE' missing; compatibility profile '$COMPAT_PROFILE' exists"
    PROFILE="$COMPAT_PROFILE"
  else
    fail "AWS profile '$PROFILE' missing. Configure SSO/profile access for each teammate."
  fi

  configured_region="$(aws configure get region --profile "$PROFILE" 2>/dev/null || true)"
  if [ -n "$configured_region" ]; then
    ok "AWS profile region is '$configured_region'"
  else
    warn "AWS profile region not set; using '$REGION' for checks"
  fi

  identity_output="$(AWS_REGION="$REGION" aws sts get-caller-identity --profile "$PROFILE" --output json 2>&1)"
  identity_status=$?
  if [ $identity_status -eq 0 ]; then
    account_id="$(printf '%s' "$identity_output" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);console.log(j.Account||"unknown")}catch(e){console.log("unknown")}})' 2>/dev/null)"
    ok "AWS identity works for profile '$PROFILE' in account '$account_id'"
  else
    fail "AWS identity check failed for profile '$PROFILE'"
    if printf '%s' "$identity_output" | grep -qi 'certificate\|SSL\|CERTIFICATE_VERIFY_FAILED'; then
      warn "AWS CLI reported an SSL/certificate problem. Check corporate proxy/VPN settings, system date, Python cert store, and AWS_CA_BUNDLE."
    fi
    printf '%s\n' "$identity_output" | sed 's/^/  /'
  fi

  for group in "${secret_groups[@]}"; do
    IFS='|' read -r label primary fallback <<< "$group"
    found=""
    for candidate in "$primary" "$fallback"; do
      secret_output="$(AWS_REGION="$REGION" aws secretsmanager get-secret-value --profile "$PROFILE" --secret-id "$candidate" --query SecretString --output text 2>&1 >/dev/null)"
      secret_status=$?
      if [ $secret_status -eq 0 ]; then
        found="$candidate"
        break
      fi
    done
    if [ -n "$found" ]; then
      ok "$label secret is readable as '$found'"
    else
      fail "$label secret is not readable as '$primary' or '$fallback'"
    fi
  done
fi

printf '\n'
if [ $failures -eq 0 ]; then
  ok "team dev access checks passed"
else
  printf 'FAIL: %s check(s) need attention\n' "$failures"
fi

exit "$failures"
