# Devin Claude Bridge Design

## Baseline

- Branch: `release/v3.8.49`
- HEAD: `ed7db3ee5f89a144b2d931d8605534522f83de30`
- Package version: `3.8.49`
- Node: `v26.0.0`
- npm: `11.12.1`
- Pre-existing worktree state: `.tug/` untracked
- Dependency state: `node_modules` is absent; the first focused test run failed before loading tests because `tsx` was not installed.
- Tugline state: `tug` exists, but `tug search` failed with MCP connection closed and `tug doctor` hung; it was interrupted.
- Upstream check: `git ls-remote` failed because GitHub DNS was unavailable. Web search of the public repository showed the existing `devin-cli` summarizer provider, but no evidence of `devin-cli-agentic`.

## Source Anchors

- `/v1/messages`: `src/app/api/v1/messages/route.ts`
- Existing Devin provider: `open-sse/config/providers/registry/devin-cli/index.ts`
- Existing Devin executor: `open-sse/executors/devin-cli.ts`
- Executor registry: `open-sse/executors/index.ts`
- Provider registry: `open-sse/config/providers/index.ts`
- Format detection: `open-sse/services/provider.ts`
- Claude non-streaming response conversion: `open-sse/handlers/responseTranslator.ts`
- Existing Devin ACP unit test: `tests/unit/executor-devin-cli-acp-protocol-8406.test.ts`

## Findings

The existing `devin-cli` provider is intentionally OpenAI-format and summarizer-oriented. Its executor spawns `devin acp --agent-type summarizer`, flattens the message history into a single text prompt, and emits OpenAI SSE text chunks. It does not preserve Anthropic `tool_use` and `tool_result` blocks.

The safest implementation is a new provider id, `devin-cli-agentic`, with a separate executor. This leaves `devin-cli`, Anthropic OAuth, Claude OAuth, Claude Web, and all host Claude configuration code untouched. The new provider is fail-closed: it only resolves to `devin://acp/stdio`, uses the official Devin CLI ACP stdio path, and has no fallback provider.

## Architecture

Claude Code sends Anthropic Messages requests to local OmniRoute. OmniRoute resolves model ids prefixed with `devin-cli-agentic/` to a new Claude-format provider. The new executor translates the complete Anthropic request into an explicit text prompt for Devin ACP, including system text, structured message history, tool schemas, and prior tool results.

Devin remains a model backend. It must request tool execution by emitting a strict XML-wrapped JSON block:

```xml
<tool>
{"name":"Read","arguments":{"file_path":"src/index.ts"}}
</tool>
```

The bridge parses exactly one tool request per model turn, validates that the tool name was supplied in the incoming request, validates arguments against a minimal JSON Schema validator, generates a stable `tool_devin_...` id, and returns a native Anthropic `tool_use` block. If no valid tool request is present, the bridge returns text with `stop_reason: "end_turn"`.

## Error And Safety Rules

- Unsupported Anthropic content blocks fail explicitly; images are rejected.
- Unknown tools fail explicitly.
- Invalid tool arguments fail explicitly.
- Invalid tool XML/JSON fails explicitly.
- Narrative claims that a tool was executed are returned as text, not actions.
- ACP spawn, timeout, early exit, and stderr-only failures return explicit Devin errors.
- The executor never reads `~/.claude`, `~/.claude.json`, macOS Keychain paths, or host Claude config.
- Live Devin is outside normal tests and remains opt-in via `ENABLE_LIVE_DEVIN_TESTS=1`.

## Test Strategy

Focused unit tests cover serialization, tool parsing, validation, Anthropic JSON, Anthropic SSE, malformed tool output, unknown tools, invalid arguments, image rejection, timeout, and spawn failure. Environment scripts provide an offline isolation verifier without reading host Claude credentials.

