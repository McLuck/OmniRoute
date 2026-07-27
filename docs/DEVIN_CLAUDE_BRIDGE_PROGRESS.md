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

- Focused unit and ACP suite: 20 tests passed.
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

- Focused ESLint and `typecheck:core` passed.
- The complete `npm run check` reached the unit suite after lint, but the repository test
  runner did not terminate after `quota-redis-store.test.ts`: an `ioredis` client kept
  reconnecting to an unavailable local Redis endpoint. The runner was interrupted after
  repeated `ECONNREFUSED` events, so this command is not reported as passed.
- Documentation accuracy checks passed before this final status update and are rerun after it.
- The fresh image rebuild and dedicated Devin volume ownership retry passed.

## Live Devin

Not passed. After the ownership repair, a fresh `devin-auth` volume was mounted and read by
the non-root bridge user. The official CLI then reported that it was not logged in. Dynamic
model discovery and the three live scenarios therefore did not run, and no live model request
was made.

The login command resumes the complete live suite automatically after authentication:

```bash
ENABLE_LIVE_DEVIN_TESTS=1 ./scripts/devin-bridge/login-devin
```

Do not report the bridge as live-ready until `devin auth status`, dynamic model discovery,
and the three scenarios in `test-live-devin` all succeed.

## Safety record

No host Claude executable, configuration, login, OAuth token, Keychain, or Anthropic API was
used. The first pre-isolation unit attempt initialized the repository's default OmniRoute
database at `/Users/lucasisrael/.omniroute/storage.sqlite`; it was not rolled back or touched
again. All subsequent bridge commands set isolated database paths under `.sandbox`.
