#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# push-secrets-to-ssm.sh
#
# Reads secrets from .env and pushes them to AWS SSM Parameter Store
# as SecureString parameters.
#
# Run ONCE before terraform apply for each environment.
# Usage: ./terraform/scripts/push-secrets-to-ssm.sh [staging|production]
# ---------------------------------------------------------------------------
set -euo pipefail

ENVIRONMENT="${1:-staging}"
REGION="${AWS_REGION:-eu-west-2}"
PREFIX="/cctv/${ENVIRONMENT}"

# Load .env from project root
ENV_FILE="$(git rev-parse --show-toplevel)/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: .env file not found at $ENV_FILE"
  exit 1
fi

# Parse a value from .env by key name.
# Strips surrounding quotes and converts literal \n to real newlines.
get_env() {
  local key="$1"
  local raw
  raw=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | sed "s/^${key}=//")
  # Strip surrounding double or single quotes
  raw="${raw#\"}"
  raw="${raw%\"}"
  raw="${raw#\'}"
  raw="${raw%\'}"
  # Convert literal \n sequences to real newlines
  printf '%b' "$raw"
}

put_param() {
  local name="$1"
  local value="$2"
  local type="${3:-SecureString}"

  echo "  Pushing ${PREFIX}/${name} ..."
  aws ssm put-parameter \
    --region "$REGION" \
    --name "${PREFIX}/${name}" \
    --value "$value" \
    --type "$type" \
    --overwrite \
    --no-cli-pager
}

echo "Pushing secrets to SSM for environment: ${ENVIRONMENT} (${REGION})"
echo "SSM prefix: ${PREFIX}"
echo ""

put_param "db-password"         "$(get_env DB_PASSWORD)"
put_param "jwt-private-key"     "$(get_env JWT_PRIVATE_KEY)"
put_param "jwt-public-key"      "$(get_env JWT_PUBLIC_KEY)" "String"
put_param "internal-api-secret" "$(get_env INTERNAL_API_SECRET)"

echo ""
echo "Done. All secrets pushed to SSM under ${PREFIX}/"
echo ""
echo "NOTE: After terraform apply, the database module will write:"
echo "  ${PREFIX}/db-url    (full postgres connection string)"
echo "  ${PREFIX}/redis-url (redis connection string)"
echo "These are populated automatically — do not set them manually."
