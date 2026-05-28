#!/usr/bin/env bash
set -euo pipefail

printf 'HopeOneSource team dev smoke test\n'
printf 'Blast radius: Level 0 local tests plus Level 1 read-only AWS checks. No external writes, sends, deploys, or draft creation.\n\n'

npm run dev:doctor
npm test

printf '\nOK: local team dev smoke test passed.\n'
