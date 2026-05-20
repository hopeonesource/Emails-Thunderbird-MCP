#!/bin/zsh

# Source this file so exports apply to the current shell:
#   source ./scripts/load-weekly-drafts-keychain-env.zsh

script_dir="${0:A:h}"
if [[ -n "${(%):-%x}" ]]; then
  script_dir="${${(%):-%x}:A:h}"
fi

repo_root="${script_dir:h}"
kc="/Users/Caregiver/Documents/Managing Keys/bin/kc-secret.zsh"

secret_map=(
  "SF_CLIENT_ID=dev/hop43/salesforce/client-id"
  "SF_USERNAME=dev/hop43/salesforce/username"
  "SF_LOGIN_URL=dev/hop43/salesforce/login-url"
  "SF_PRIVATE_KEY=dev/hop43/salesforce/private-key"
  "GOOGLE_SERVICE_ACCOUNT_EMAIL=dev/hop43/google/service-account"
  "GOOGLE_PRIVATE_KEY=dev/hop43/google/private-key"
)

export GMAIL_SUBJECT="${GMAIL_SUBJECT:-checkins@hope1source.me}"
export GMAIL_FROM="${GMAIL_FROM:-Hope1Source Check-ins <checkins@hope1source.me>}"
export GMAIL_REVIEW_RECIPIENT="${GMAIL_REVIEW_RECIPIENT:-checkins@hope1source.me}"
export HOP43_ALLOWED_ACCOUNT_NAMES="${HOP43_ALLOWED_ACCOUNT_NAMES:-Bethel Cafe}"
export SF_STAMP_FEEDBACK_EMAIL_SENT="${SF_STAMP_FEEDBACK_EMAIL_SENT:-false}"

if [[ "${1:-}" == "--list" ]]; then
  for item in "${secret_map[@]}"; do
    print "$item"
  done
  print "GMAIL_SUBJECT=${GMAIL_SUBJECT}"
  print "GMAIL_FROM=${GMAIL_FROM}"
  print "GMAIL_REVIEW_RECIPIENT=${GMAIL_REVIEW_RECIPIENT}"
  print "HOP43_ALLOWED_ACCOUNT_NAMES=${HOP43_ALLOWED_ACCOUNT_NAMES}"
  print "SF_STAMP_FEEDBACK_EMAIL_SENT=${SF_STAMP_FEEDBACK_EMAIL_SENT}"
  return 0 2>/dev/null || exit 0
fi

if [[ ! -x "$kc" ]]; then
  print "Missing Keychain helper: ${kc}" >&2
  return 1 2>/dev/null || exit 1
fi

loaded=0
missing=0
for item in "${secret_map[@]}"; do
  env_name="${item%%=*}"
  service="${item#*=}"

  if "$kc" exists "$service"; then
    export "${env_name}=$("$kc" get "$service")"
    loaded=$((loaded + 1))
  else
    print "Missing Keychain secret: ${service}" >&2
    missing=$((missing + 1))
  fi
done

print "Loaded ${loaded} HOP-43 secret(s) from macOS Keychain."
if [[ "$missing" -gt 0 ]]; then
  print "Missing ${missing} HOP-43 secret(s). Store them with kc-secret.zsh before live validation." >&2
fi
