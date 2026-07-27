# Devin Claude Bridge

`devin-cli-agentic` lets the real Claude Code runtime use OmniRoute's local Anthropic
Messages endpoint while the official Devin CLI supplies model responses over ACP stdio.
It does not modify the existing Anthropic, Claude OAuth, Claude Web, or `devin-cli`
providers.

## Architecture

```text
Claude Code 2.1.220 (isolated Linux container)
  -> http://omniroute:20128/v1/messages
  -> devin-cli-agentic (Claude-format, no-auth provider)
  -> devin acp --agent-type summarizer (ACP v1 over stdio)
  -> Devin account in the dedicated devin-auth volume (live profile only)
```

The serializer in `open-sse/executors/devin-agentic/serializer.ts` preserves `system`,
`text`, `tool_use`, `tool_result`, `thinking`, `redacted_thinking`, `tool_choice`, and the
tools supplied by Claude Code. Images and unknown content blocks fail explicitly. Large
tool results use a visible truncation marker.

The parser accepts one standalone `<tool>{...}</tool>` envelope per model turn. It checks
the requested name against the request's tool list, validates arguments against that
tool's JSON Schema, rejects mixed narrative/actions, and permits one bounded repair.
Claude Code executes the resulting Anthropic `tool_use`; Devin never executes those local
tools through this adapter.

## Threat model and isolation

The bridge assumes the host contains an unrelated personal Claude installation and treats
all host Claude configuration and credentials as forbidden. The Compose services:

- run as UID/GID `10001:10001`, with a read-only root filesystem, all capabilities dropped,
  and `no-new-privileges`;
- use `/home/bridge`, a dedicated named Claude config volume, separate OmniRoute data
  volumes, and a separate `devin-auth` volume;
- mount only disposable `.sandbox` workspaces/evidence and the bridge test harness;
- do not mount the host home, SSH files, cloud credentials, Keychain, or Docker socket;
- provide an explicit environment and remove Anthropic OAuth/API/routing variables before
  Claude Code and the Devin subprocess run;
- direct Claude Code inference only to `http://omniroute:20128` using a local OmniRoute key.

The `offline` network is internal, so no runtime container can reach the Internet. The
`live-devin` OmniRoute service is also attached only to that internal network; outbound
HTTP(S) goes through `network-guard`, whose only allowed suffixes are `.devin.ai` and
`.cognition.ai`. Anthropic, Claude, Statsig, Sentry, and every unrelated destination are
denied by default. The guards write their canonical audit logs to the guard-only binds
`.sandbox/guard-audit/devin/egress.jsonl` and
`.sandbox/guard-audit/claude/egress.jsonl`. Runtime services do not mount those directories.
After the guarded services stop, the scripts validate file ownership, mode, link count, and
every audit decision before copying the token-free audit record into `.sandbox/evidence`.

Run the executable proof at any time:

```bash
./scripts/devin-bridge/verify-anthropic-isolation
```

It validates Compose topology, named config mounts, non-root/read-only settings, explicit
local routing, absence of sensitive environment variables, absence of the Docker socket,
and failed TCP access to `api.anthropic.com` and `claude.ai`. The wire contract separately
stops the mock ACP process and confirms an explicit error with no fallback.

## Reproducible offline validation

The normal automated path does not need a Devin account and has no runtime Internet:

```bash
./scripts/devin-bridge/build
./scripts/devin-bridge/test-unit
./scripts/devin-bridge/test-contract
./scripts/devin-bridge/test-e2e-mock
./scripts/devin-bridge/verify-anthropic-isolation
```

`test-e2e-mock` copies `tests/fixtures/devin-bridge/e2e-workspace` into `.sandbox`, then
runs the pinned Claude Code binary. The fixture contains `CLAUDE.md`, a project skill, a
slash command, hooks, source, and tests. The deterministic ACP mock asks Claude Code to
locate, read, edit, test, observe a failure, repair, retest, and finish. Evidence stays
unversioned in `.sandbox/evidence`.

## Devin login and live use

Authentication uses only the official CLI inside the dedicated volume. It never imports a
host session:

```bash
ENABLE_LIVE_DEVIN_TESTS=1 ./scripts/devin-bridge/login-devin
```

After login, the live test accepts `devin auth status` only when its output contains the exact
line `Logged in (via Devin)`. It then obtains the account's machine-readable model list with
`devin models list --format json`, selects an identifier from an explicit model-identifier
field, and runs three disposable Claude Code scenarios:

```bash
ENABLE_LIVE_DEVIN_TESTS=1 ./scripts/devin-bridge/test-live-devin
```

For interactive use, `launch` repeats isolation, auth, and model discovery checks before
starting the containerized Claude Code runtime:

```bash
./scripts/devin-bridge/launch
```

Optional model aliases live in `.env.devin-bridge.example`. `DEVIN_BRIDGE_MODEL` controls
the main model; `DEVIN_BRIDGE_SONNET_MODEL`, `DEVIN_BRIDGE_OPUS_MODEL`,
`DEVIN_BRIDGE_HAIKU_MODEL`, and `DEVIN_BRIDGE_SUBAGENT_MODEL` allow explicit mapping. Every
value must retain the `devin-cli-agentic/` prefix. The live test uses a model returned by
the current Devin account instead of trusting the example value.

## Updating pinned tools

The image pins Node, Claude Code, and Devin CLI in `docker/devin-bridge/Dockerfile` and
`docker/devin-bridge/compose.yml`. To update:

1. change the explicit version arguments;
2. update both architecture-specific Devin archive checksums from the official artifact;
3. run the complete offline command set above;
4. confirm the artifact versions inside the rebuilt image;
5. run the live suite only after offline proof remains green.

Do not replace the checksum with an unverified download or install either CLI globally on
the host.

## Diagnosis and cleanup

- `docker compose -f docker/devin-bridge/compose.yml --profile offline logs omniroute`
  shows local routing and sanitized executor failures.
- `.sandbox/evidence/mock-acp.jsonl` records deterministic offline provider actions.
- `.sandbox/evidence/claude-stream.jsonl` records the real Claude Code offline run.
- `.sandbox/guard-audit/devin/egress.jsonl` and
  `.sandbox/guard-audit/claude/egress.jsonl` are the canonical guard-only audit files.
- `.sandbox/evidence/egress.jsonl`, `.sandbox/evidence/claude-egress.jsonl`, and
  `.sandbox/evidence/claude-egress-verifier.jsonl` are validated, post-shutdown copies
  without tokens.
- An ACP timeout, malformed frame, unavailable binary/model, or process exit is an explicit
  `502`; it never selects a second provider.

Stop containers and networks while preserving login/config volumes:

```bash
./scripts/devin-bridge/clean
```

Remove the complete bridge-owned environment, including named volumes:

```bash
./scripts/devin-bridge/clean --all
```

`.sandbox` can then be deleted independently; it contains only disposable fixtures,
isolated databases, and evidence.

## Limits

- ACP context is reconstructed from each Anthropic request; there is no persistent process
  or session affinity.
- One tool call is supported per model response; parallel tool calls are rejected.
- Images are explicitly unsupported. Vision, thinking output, effort controls, and a 1M
  context window are not advertised as bridge capabilities.
- SSE has valid Anthropic lifecycle events but is rendered after the bounded ACP response is
  collected; ACP chunks are not forwarded incrementally to the client.
- The strict parser depends on the Devin model following the documented tool envelope. One
  repair is attempted before the request fails.
- Offline proof is deterministic. Live readiness requires a successful official Devin login
  and all three live scenarios; it must not be inferred from offline results.
