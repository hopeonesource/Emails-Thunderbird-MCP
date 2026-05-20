#!/bin/zsh
set -euo pipefail

kc="/Users/Caregiver/Documents/Managing Keys/bin/kc-secret.zsh"

store_optional() {
  local service="$1"
  local label="$2"

  print
  print "$label"
  "$kc" set "$service"
}

print "This stores HOP-43 local development secrets in macOS Keychain."
print "Press Enter at any prompt to skip that value."
print "Do not paste secrets into chat or tracked files."

store_optional "dev/hop43/salesforce/client-id" "Salesforce Connected App Client ID"
store_optional "dev/hop43/salesforce/username" "Salesforce integration username"
store_optional "dev/hop43/salesforce/login-url" "Salesforce login URL, for example https://test.salesforce.com"
store_optional "dev/hop43/salesforce/private-key" "Salesforce JWT private key PEM"
store_optional "dev/hop43/google/service-account" "Google service account email"
store_optional "dev/hop43/google/private-key" "Google service account private key PEM"

print
print "Done. Load saved values with:"
print "  source ./scripts/load-weekly-drafts-keychain-env.zsh"
