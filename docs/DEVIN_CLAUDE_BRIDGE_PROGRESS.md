# Devin Claude Bridge Progress

Updated: 2026-07-27

## Baseline

- Fork version: `3.8.49`.
- Starting branch: `release/v3.8.49`.
- Starting commit: `ed7db3ee5f89a144b2d931d8605534522f83de30`.
- Fixed runtime artifacts: Node `26.0.0`, Claude Code `2.1.220`, Devin CLI `3000.2.17`.
- Existing `devin-cli` remains unchanged; the new path is the separate
  `devin-cli-agentic` provider.

## Proved offline

- Focused unit and ACP suite: 27 tests passed.
- Anthropic wire suite: non-streaming JSON, SSE event order, `tool_use`, direct
  `tool_result` continuation, ACP error, and early process exit passed.
- Final container build completed with the pinned CLIs and the production OmniRoute build.
- Artifact inspection confirmed Node `26.0.0`, Claude Code `2.1.220`, and Devin CLI
  `3000.2.17` while the container had no network.
- Runtime isolation verifier passed in static and container checks.
- Real Claude Code offline E2E passed in 9 turns. It loaded `CLAUDE.md`, discovered the
  project skill and slash command, fired hooks, requested `Skill`, `Bash`, `Read`, and
  `Edit`, observed a failing test, corrected the edit, reran the test successfully, and
  returned the fixture's final success marker.
- Every offline inference action recorded by the ACP fixture names only
  `devin-cli-agentic`; provider termination returned an explicit error.

Evidence is generated under `.sandbox/evidence` and is intentionally ignored by Git.

## Regression status

- Focused ESLint and `typecheck:core` passed; the final executor changes were rechecked with
  `typecheck:core` and the 27-test bridge suite.
- The complete `npm run check` reached the unit suite after lint, but the repository test
  runner did not terminate after `quota-redis-store.test.ts`: an `ioredis` client kept
  reconnecting to an unavailable local Redis endpoint. The runner was interrupted after
  repeated `ECONNREFUSED` events, so this command is not reported as passed.
- Documentation accuracy checks passed before this final status update and are rerun after it.
- The fresh image rebuild and dedicated Devin volume ownership retry passed.

## Live Devin

Not passed. The official Devin login succeeded inside the dedicated volume, and model
discovery selected `swe-1-7-lightning`. Authorized live runs established the following:

1. `devin acp --agent-type summarizer` is not a neutral inference backend. The CLI's own
   help identifies it as a no-tools summarizer, and its injected role caused future-action
   narration, summaries, and malformed tool envelopes instead of a reliable Claude Code
   tool loop.
2. The default `devin acp` agent can emit the required XML tool envelope in a minimal probe,
   but the full Claude Code request caused it to emit ACP `tool_call` events and attempt to
   own tool execution.
3. The adapter now rejects `tool_call` and `tool_call_update` with
   `devin_internal_tool_execution` (`502`). Two live requests were observed failing closed;
   a third in-flight request was aborted when the test was stopped to avoid automatic paid
   retries.
4. No three-scenario live pass exists. The live test must remain red until the official CLI
   exposes a neutral no-tools generation mode (without the summarizer role) or another
   supported Devin API provides equivalent raw model inference.

The offline contract still proves `narrative -> single repair -> tool_use`, and a second
narrative now fails closed instead of being accepted as a successful final response.

## Safety record

No host Claude executable, configuration, login, OAuth token, Keychain, or Anthropic API was
used. The first pre-isolation unit attempt initialized the repository's default OmniRoute
database at `/Users/lucasisrael/.omniroute/storage.sqlite`; it was not rolled back or touched
again. All subsequent bridge commands set isolated database paths under `.sandbox`.

The final live attempts used only the dedicated Docker volumes. Claude Code ran only inside
the non-root container; no host Claude configuration or credential path was mounted or read.
