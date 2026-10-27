#!/usr/bin/env bash
# Creates (or updates) the Secrets Manager secret the stack reads.
# Values come from your shell environment, so they never end up in the repo
# or in CloudFormation. Usage:
#
#   export DATABASE_URL='postgres://user:pass@host/db?sslmode=require'
#   export SLACK_SIGNING_SECRET=...   # optional, for Slack
#   export SLACK_BOT_TOKEN=xoxb-...   # optional, for @mentions
#   export OPENAI_API_KEY=sk-...      # optional, only if you use OpenAI
#   ./scripts/create-secret.sh
set -euo pipefail

NAME="${SECRET_NAME:-ticketwise/app}"
: "${DATABASE_URL:?Set DATABASE_URL first}"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"

SECRET_JSON=$(node -e '
const e = process.env;
const out = { DATABASE_URL: e.DATABASE_URL, ADMIN_TOKEN: e.ADMIN_TOKEN_VALUE };
for (const k of ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "OPENAI_API_KEY"]) if (e[k]) out[k] = e[k];
process.stdout.write(JSON.stringify(out));
' ADMIN_TOKEN_VALUE="$ADMIN_TOKEN")

if aws secretsmanager describe-secret --secret-id "$NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$NAME" --secret-string "$SECRET_JSON" >/dev/null
  echo "Updated secret $NAME"
else
  aws secretsmanager create-secret --name "$NAME" --secret-string "$SECRET_JSON" >/dev/null
  echo "Created secret $NAME"
fi
echo
echo "Admin token (paste into the admin Settings page): $ADMIN_TOKEN"
