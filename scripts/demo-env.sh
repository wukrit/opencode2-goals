#!/usr/bin/env bash
# Prepares an ISOLATED OpenCode environment (fresh XDG data/config, so the
# shared server, config, and DB are untouched) that loads opencode2-goals
# from this checkout as a directory install, and launches the TUI in a
# scratch project. Used by scripts/demo.tape (VHS) for the README capture.
#
#   bash scripts/demo-env.sh            # interactive (manual rehearsal)
#   vhs scripts/demo.tape               # the actual recording
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEMO="$ROOT/.demo"

rm -rf "$DEMO"
mkdir -p "$DEMO/data" "$DEMO/config/opencode" "$DEMO/proj"

# Goals plugin from this checkout; if the local LiteLLM models plugin exists,
# add it too so a model is preselected and the TUI skips provider onboarding.
MODELS_PLUGIN="/Users/sukrit/Projects/opencode-litellm-models"
EXTRA=""
if [ -d "$MODELS_PLUGIN" ]; then
  # Same options as the maintainer's global config, so model resolution in
  # the standalone demo matches the known-good shared server.
  EXTRA="{ \"package\": \"$MODELS_PLUGIN\", \"options\": { \"baseURL\": \"https://inference.middesk.com/v1\", \"extraModels\": [\"openai/gpt-6-sol\", \"openai/gpt-6-luna\"] } },"
fi
cat > "$DEMO/config/opencode/opencode.jsonc" <<EOF
{
  "model": "litellm/openai/gpt-5.6-terra",
  "plugins": [
    $EXTRA
    { "package": "$ROOT", "options": { "stallLimit": 3 } }
  ],
  "providers": {
    "litellm": {
      "name": "Middesk LiteLLM",
      "env": ["LITELLM_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://inference.middesk.com/v1" },
      "body": { "drop_params": true }
    }
  }
}
EOF

cd "$DEMO/proj"
exec env XDG_DATA_HOME="$DEMO/data" XDG_CONFIG_HOME="$DEMO/config" opencode --standalone "$@"
