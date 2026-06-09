#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMUX_CLI="$PROJECT_ROOT/scripts/tmux/tmux-cli.sh"

MODEL="${1:-gpt-5.5}"
PROMPT="${2:-hi}"
SESSION_NAME="dev-runtime-smoke-$(date +%s)-$$"
SETTINGS_PATH="$HOME/.config/manicode-dev/settings.json"

capture_and_get_path() {
    local session="$1"
    local label="$2"
    local wait_seconds="${3:-1}"
    local capture_output

    capture_output=$("$TMUX_CLI" capture "$session" --label "$label" --wait "$wait_seconds")
    printf '%s\n' "$capture_output"
    printf '%s\n' "$capture_output" | sed -n 's/^\[Saved: \(.*\)\] \[.*$/\1/p' | head -n 1
}

require_file() {
    local file_path="$1"
    local description="$2"

    if [[ ! -f "$file_path" ]]; then
        echo "Missing $description: $file_path" >&2
        exit 1
    fi
}

cleanup() {
    "$TMUX_CLI" stop "$SESSION_NAME" >/dev/null 2>&1 || true
}

trap cleanup EXIT

if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is required for this smoke test." >&2
    exit 1
fi

echo "Starting Local Dev CLI smoke session: $SESSION_NAME"
"$TMUX_CLI" start \
    --command "bun start-cli" \
    --name "$SESSION_NAME" \
    -w 160 \
    -h 40 \
    --wait 6 >/dev/null

startup_capture_path=$(capture_and_get_path "$SESSION_NAME" "startup" 1 | tail -n 1)
require_file "$startup_capture_path" "startup capture"

if rg -n "Runtime: dev .*manicode-dev" "$startup_capture_path" >/dev/null 2>&1; then
    echo "Verified header exposes the dev runtime identity."
else
    echo "WARNING: startup capture did not contain the dev runtime identity." >&2
fi

echo "Selecting OpenAI model: $MODEL"
"$TMUX_CLI" send "$SESSION_NAME" "/model $MODEL" --wait-idle 2 >/dev/null
model_capture_path=$(capture_and_get_path "$SESSION_NAME" "after-model" 1 | tail -n 1)
require_file "$model_capture_path" "model capture"

if [[ -f "$SETTINGS_PATH" ]] && rg -n "\"openAiModel\"\\s*:\\s*\"$MODEL\"" "$SETTINGS_PATH" >/dev/null 2>&1; then
    echo "Verified $SETTINGS_PATH persisted openAiModel=$MODEL."
else
    echo "WARNING: $SETTINGS_PATH did not contain openAiModel=$MODEL." >&2
fi

echo "Sending prompt: $PROMPT"
"$TMUX_CLI" send "$SESSION_NAME" "$PROMPT" --wait-idle 4 >/dev/null
prompt_capture_path=$(capture_and_get_path "$SESSION_NAME" "after-prompt" 1 | tail -n 1)
require_file "$prompt_capture_path" "prompt capture"

if rg -qi "reconnect via /connect|connect via /connect|connection expired" "$prompt_capture_path"; then
    echo "Observed the expected OpenAI blocking/reconnect guidance."
elif rg -qi "connecting\\.\\.\\." "$prompt_capture_path"; then
    echo "WARNING: prompt capture still shows connecting..." >&2
else
    echo "NOTE: no blocking message was detected. You may already have a valid ChatGPT OAuth connection." >&2
fi

echo "Captures saved under: $PROJECT_ROOT/debug/tmux-sessions/$SESSION_NAME"
