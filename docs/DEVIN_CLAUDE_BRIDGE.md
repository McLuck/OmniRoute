# Devin Claude Bridge

This bridge adds `devin-cli-agentic`, a fail-closed provider for local Claude Code
traffic on OmniRoute's Anthropic Messages surface.

## Implemented

- New Claude-format provider: `devin-cli-agentic`.
- New executor: `open-sse/executors/devin-cli-agentic.ts`.
- ACP stdio flow: `initialize`, `session/new`, `session/prompt`, `session/update`.
- Native Anthropic JSON responses for text and `tool_use`.
- Native Anthropic SSE lifecycle frames for streaming clients.
- Strict parser for one Devin-requested tool call using `<tool>{...}</tool>`.
- Offline unit tests with a mock Devin CLI.
- Local isolation preflight script.

## Not Implemented

- Docker Compose profiles are not complete in this attempt.
- Real Claude Code E2E inside a container is not proven in this attempt.
- Live Devin tests are not run; they remain opt-in via `ENABLE_LIVE_DEVIN_TESTS=1`.
- Session affinity is intentionally not implemented.

## Usage

Route Claude Code model aliases to `devin-cli-agentic/<model>`, for example:

```bash
ANTHROPIC_BASE_URL=http://localhost:20128
ANTHROPIC_AUTH_TOKEN=sk-local-devin-gateway
ANTHROPIC_DEFAULT_SONNET_MODEL=devin-cli-agentic/swe-1-7
```

The executor uses `CLI_DEVIN_AGENTIC_BIN` first, then `CLI_DEVIN_BIN`, then PATH.

## Isolation

Normal tests use a mock Devin binary and do not execute Claude Code. The bridge does
not read host Claude files. The preflight script requires local OmniRoute routing and
rejects Anthropic/Claude credential environment variables:

```bash
CLAUDE_CONFIG_DIR=.sandbox/claude-devin-isolated \
ANTHROPIC_BASE_URL=http://localhost:20128 \
ANTHROPIC_AUTH_TOKEN=sk-local-devin-gateway \
./scripts/devin-bridge/verify-anthropic-isolation
```

## Verification

```bash
./scripts/devin-bridge/test-unit
npm test
```

In this workspace, `node_modules` was missing during implementation, so `tsx` could
not be resolved until dependencies are installed.

