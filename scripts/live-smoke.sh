#!/usr/bin/env bash
# Live smoke test — the plugin's behavior against the real host, no mocks.
# Boots `opencode serve` in a fully isolated environment (XDG dirs redirected
# to a temp folder, so the shared server, config, and DB are untouched),
# loads this checkout as a directory-install plugin, and fails unless the
# host's command list includes /goal. No model call is made.
#
#   bash scripts/live-smoke.sh
#
# Exits 0 on PASS, 1 on FAIL. Requires the `opencode` v2 CLI on PATH.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV=$(mktemp -d "${TMPDIR:-/tmp}/goals-live-smoke.XXXXXX")
PORT=47933
API="http://127.0.0.1:${PORT}"

cleanup() {
  kill "${SV:-}" 2>/dev/null || true
  wait "${SV:-}" 2>/dev/null || true
  rm -rf "$ENV"
}
trap cleanup EXIT

mkdir -p "$ENV/data" "$ENV/config/opencode" "$ENV/proj"
printf '{ "plugins": [{ "package": "%s", "options": {} }] }\n' "$ROOT" \
  > "$ENV/config/opencode/opencode.jsonc"

( cd "$ENV/proj" \
  && XDG_DATA_HOME="$ENV/data" XDG_CONFIG_HOME="$ENV/config" \
     opencode serve --port "$PORT" >"$ENV/serve.out" 2>&1 ) & SV=$!

# Wait for the server line + auth password the CLI prints on stdout.
PASS=""
for _ in $(seq 30); do
  PASS=$(sed -n 's/^server password //p' "$ENV/serve.out" 2>/dev/null || true)
  [ -n "$PASS" ] && break
  sleep 1
done
if [ -z "$PASS" ]; then
  echo "FAIL: opencode serve did not report a password within 30s" >&2
  cat "$ENV/serve.out" >&2 || true
  exit 1
fi

# Materialize the location so config-scoped plugin surfaces initialize.
curl -sf -u "opencode:$PASS" -X POST "$API/api/location/reload" \
  -H 'content-type: application/json' \
  -d "{\"directory\":\"$ENV/proj\"}" >/dev/null || true

# The decisive check: the host must report the plugin's /goal command.
for _ in $(seq 10); do
  if curl -sf -u "opencode:$PASS" -G "$API/api/command" \
      --data-urlencode "location[directory]=$ENV/proj" \
     | grep -q '"name":"goal"'; then
    echo "PASS: $(opencode --version 2>/dev/null | head -1) loaded the plugin; /goal is registered"
    exit 0
  fi
  sleep 1
done

echo "FAIL: /goal missing from the host command list" >&2
curl -s -u "opencode:$PASS" -G "$API/api/command" \
  --data-urlencode "location[directory]=$ENV/proj" >&2 || true
exit 1
