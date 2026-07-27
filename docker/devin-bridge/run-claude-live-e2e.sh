#!/usr/bin/env bash
set -euo pipefail

unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BEDROCK_BASE_URL ANTHROPIC_VERTEX_BASE_URL
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY

run_scenario() {
  local evidence_file="$1"
  local prompt="$2"
  claude -p --output-format stream-json --verbose --max-turns 12 \
    --permission-mode bypassPermissions "$prompt" | tee "$evidence_file"
  if grep -Eqi 'log[ -]?in|authenticate.*anthropic|claude\.ai' "$evidence_file"; then
    echo "Claude Code requested forbidden authentication" >&2
    exit 1
  fi
}

run_scenario /evidence/live-analysis.jsonl \
  "Read CLAUDE.md, inspect math.js and its test without editing, explain the defect, then end with LIVE_ANALYSIS_COMPLETE."
grep -q LIVE_ANALYSIS_COMPLETE /evidence/live-analysis.jsonl

run_scenario /evidence/live-fix.jsonl \
  "Fix the defect in math.js, run npm test, and end with LIVE_FIX_COMPLETE only after the test passes."
grep -q 'return a + b;' /workspace/math.js
npm test
grep -q LIVE_FIX_COMPLETE /evidence/live-fix.jsonl

run_scenario /evidence/live-command.jsonl "/bridge-check"
grep -q BRIDGE_E2E_COMPLETE /evidence/live-command.jsonl

printf 'PASS: three live Devin-backed Claude Code scenarios completed\n'
