# Devin Claude Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed `devin-cli-agentic` provider that serves local Anthropic Messages requests through Devin CLI ACP stdio while preserving Claude Code tool-use semantics.

**Architecture:** Add a separate Claude-format provider and executor instead of changing the existing OpenAI-format `devin-cli` summarizer. Keep parsing, prompt serialization, Anthropic response rendering, and ACP process handling in focused files under `open-sse/executors/devin-agentic/`, then wire them into the existing provider and executor registries.

**Tech Stack:** TypeScript ES modules, Node child process stdio, Anthropic Messages JSON/SSE, JSON-RPC 2.0 ACP, Node test runner.

---

### Task 1: Agentic Bridge Core

**Files:**
- Create: `open-sse/executors/devin-agentic/types.ts`
- Create: `open-sse/executors/devin-agentic/serializer.ts`
- Create: `open-sse/executors/devin-agentic/toolParser.ts`
- Create: `open-sse/executors/devin-agentic/anthropicResponse.ts`
- Test: `tests/unit/executor-devin-cli-agentic-core.test.ts`

- [ ] **Implement and prove serialization, parsing, validation, and Anthropic rendering**

Interfaces:

```ts
export function serializeAnthropicForDevin(body: unknown): DevinPrompt;
export function parseDevinToolRequest(text: string, tools: AnthropicTool[]): ParsedToolRequest | null;
export function buildClaudeTextResponse(args: ClaudeResponseArgs): Record<string, unknown>;
export function buildClaudeToolUseResponse(args: ClaudeToolUseArgs): Record<string, unknown>;
export function buildClaudeSseFrames(message: Record<string, unknown>): string;
```

Invariants:

- Preserve `text`, `tool_use`, `tool_result`, `thinking`, and `redacted_thinking`.
- Reject `image` with a clear error.
- Reject unknown content block types.
- Allow only one tool request per model turn.
- Validate tool arguments against object JSON Schema with `required`, `type`, `properties`, `additionalProperties`, `enum`, `items`, and scalar types.
- Generate deterministic ids from tool name and canonicalized arguments.

Run: `node --import tsx/esm --test tests/unit/executor-devin-cli-agentic-core.test.ts`
Expected: core tests pass after dependencies are installed.

### Task 2: ACP Executor And Provider Wiring

**Files:**
- Create: `open-sse/executors/devin-cli-agentic.ts`
- Modify: `open-sse/executors/index.ts`
- Create: `open-sse/config/providers/registry/devin-cli-agentic/index.ts`
- Modify: `open-sse/config/providers/index.ts`
- Test: `tests/unit/executor-devin-cli-agentic-acp.test.ts`

- [ ] **Implement and prove fail-closed ACP execution**

Behavior:

- `buildUrl()` returns `devin://acp/stdio`.
- `buildHeaders()` returns `{}`.
- `execute()` spawns only `devin acp` by default or the explicit `CLI_DEVIN_AGENTIC_BIN`/`CLI_DEVIN_BIN` override.
- The child environment removes Anthropic and Claude routing credentials before spawn.
- The executor sends `initialize`, `session/new`, and `session/prompt`.
- The executor collects `agent_message_chunk` text and `session/prompt` final result.
- Non-streaming Claude clients receive native Anthropic JSON.
- Streaming Claude clients receive native Anthropic SSE lifecycle frames.
- Spawn failure, ACP error, timeout, and early exit produce non-2xx responses with sanitized messages.

Run: `node --import tsx/esm --test tests/unit/executor-devin-cli-agentic-acp.test.ts`
Expected: ACP mock tests pass after dependencies are installed.

### Task 3: Isolation Scripts And Documentation

**Files:**
- Create: `scripts/devin-bridge/verify-anthropic-isolation`
- Create: `scripts/devin-bridge/test-unit`
- Create: `scripts/devin-bridge/launch`
- Create: `docs/DEVIN_CLAUDE_BRIDGE.md`
- Modify: `.gitignore`

- [ ] **Implement offline guardrails and operator docs**

Behavior:

- `verify-anthropic-isolation` fails if `CLAUDE_CONFIG_DIR` is missing, points outside an isolated path, or if Anthropic routing env vars are present.
- `test-unit` runs the focused unit tests.
- `launch` refuses to start unless `ENABLE_LIVE_DEVIN_TESTS=1` for live Devin or `DEVIN_BRIDGE_OFFLINE=1` for offline mock mode.
- Documentation distinguishes tested offline behavior from live Devin opt-in behavior.

Run: `./scripts/devin-bridge/verify-anthropic-isolation` with explicit isolated env.
Expected: exits 0 with isolated env and non-zero without it.

### Task 4: Verification

**Files:**
- No additional source files.

- [ ] **Run proportional checks and capture real output**

Commands:

```bash
./scripts/devin-bridge/test-unit
npm test
```

Expected in this workspace before installing dependencies: both commands fail with `ERR_MODULE_NOT_FOUND` for `tsx`. Expected after `npm install`: focused tests pass; `npm test` outcome must be reported from real output.

