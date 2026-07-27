import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const composePath = path.join(root, "docker", "devin-bridge", "compose.yml");
const commonPath = path.join(root, "scripts", "devin-bridge", "common");
const mockE2ePath = path.join(root, "scripts", "devin-bridge", "test-e2e-mock");
const launchPath = path.join(root, "scripts", "devin-bridge", "launch");
const loginPath = path.join(root, "scripts", "devin-bridge", "login-devin");
const selectorPath = path.join(root, "scripts", "devin-bridge", "select-live-model.mjs");
const liveE2ePath = path.join(root, "scripts", "devin-bridge", "test-live-devin");
const verifierPath = path.join(root, "scripts", "devin-bridge", "verify-anthropic-isolation");

function composeConfig() {
  const result = spawnSync(
    "docker-compose",
    [
      "-f",
      composePath,
      "--env-file",
      "/dev/null",
      "--profile",
      "offline",
      "--profile",
      "live-devin",
      "config",
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function volumeSources(service: { volumes?: Array<string | { source?: string }> }): string[] {
  return (service.volumes || []).map((mount) =>
    typeof mount === "string" ? mount.split(":", 1)[0] : String(mount.source || "")
  );
}

function networkNames(service: { networks?: string[] | Record<string, unknown> }): string[] {
  return Array.isArray(service.networks) ? service.networks : Object.keys(service.networks || {});
}

function assertAuthStatus(exitStatus: number, output: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; bridge_assert_devin_auth_status "$2" "$3"',
      "bridge-auth-test",
      commonPath,
      String(exitStatus),
      output,
    ],
    { cwd: root, encoding: "utf8" }
  );
}

function selectModel(document: unknown, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", selectorPath], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(document),
    env: { PATH: process.env.PATH, ...env },
  });
}

function runCommon(functionName: string, filePath: string) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; "$2" "$3"', "bridge-audit-test", commonPath, functionName, filePath],
    { cwd: root, encoding: "utf8" }
  );
}

test("network policy permits only Devin/Cognition and exact Codeium control-plane hosts", async () => {
  const { isAllowedGuardHostname } =
    await import("../../docker/devin-bridge/network-guard/policy.mjs");

  for (const hostname of [
    "api.devin.ai",
    "devin.ai",
    "nested.api.cognition.ai",
    "cognition.ai",
    "server.codeium.com",
    "unleash.codeium.com",
  ]) {
    assert.equal(isAllowedGuardHostname(hostname, "devin"), true, hostname);
  }
  for (const hostname of [
    "evildevin.ai",
    "codeium.com",
    "api.codeium.com",
    "server.codeium.com.evil.example",
    "o123.ingest.sentry.io",
    "api.anthropic.com",
    "claude.ai",
  ]) {
    assert.equal(isAllowedGuardHostname(hostname, "devin"), false, hostname);
  }
  assert.equal(isAllowedGuardHostname("api.devin.ai", "deny-all"), false);
});

test("compose separates Claude config, Devin auth, and the two egress guards", () => {
  const config = composeConfig();
  const services = config.services;

  for (const [name, service] of Object.entries(services) as Array<
    [string, { environment?: Record<string, string>; networks?: object; volumes?: object[] }]
  >) {
    const sources = volumeSources(service);
    assert.equal(
      sources.some(
        (source) =>
          source === "claude-isolated-config" || source.endsWith("_claude-isolated-config")
      ),
      name === "claude" || name === "claude-live",
      `${name} Claude config volume ownership`
    );
    assert.equal(
      sources.some((source) => source === "devin-auth" || source.endsWith("_devin-auth")),
      name === "omniroute-live",
      `${name} Devin auth volume ownership`
    );
  }

  assert.equal(
    services["omniroute-live"].environment.DEVIN_BRIDGE_PROXY_URL,
    "http://network-guard:8080"
  );
  assert.equal(services["omniroute-live"].environment.HTTP_PROXY, undefined);
  assert.equal(services["omniroute-live"].environment.HTTPS_PROXY, undefined);

  for (const name of ["claude", "claude-live"]) {
    const env = services[name].environment;
    assert.equal(env.NODE_USE_ENV_PROXY, "1");
    assert.equal(env.HTTP_PROXY, "http://claude-egress-guard:8080");
    assert.equal(env.HTTPS_PROXY, "http://claude-egress-guard:8080");
    assert.equal(env.NO_PROXY, "omniroute");
    assert.notEqual(env.HTTP_PROXY, "http://network-guard:8080");
  }

  assert.equal(services["network-guard"].environment.GUARD_POLICY, "devin");
  assert.equal(services["claude-egress-guard"].environment.GUARD_POLICY, "deny-all");
  assert.deepEqual(networkNames(services["claude-egress-guard"]), ["bridge-internal"]);
});

test("auth status gate requires a clean server-confirmed login", () => {
  assert.equal(assertAuthStatus(0, "Logged in (via Devin)\n").status, 0);
  assert.notEqual(
    assertAuthStatus(0, "Logged in (via Devin)\nFailed to fetch from server\n").status,
    0
  );
  assert.notEqual(assertAuthStatus(0, "Logged out\n").status, 0);
  assert.notEqual(assertAuthStatus(1, "Logged in (via Devin)\n").status, 0);
});

test("live model selection normalizes real family/model uid fields and prefers lightning", () => {
  const result = selectModel({
    models: [
      { family_uid: "swe-1.7" },
      { familyUid: "swe-1.7-lightning" },
      { model_uid: "swe-1.6-fast" },
      { modelUid: "swe-1.6" },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "swe-1-7-lightning");
});

test("live model selection rejects normalized identifiers absent from the catalog", () => {
  const result = selectModel({ models: [{ family_uid: "swe-9.9-unknown" }] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no model identifier present/i);
});

test("login uses the official manual token flow without accepting tokens as arguments", () => {
  const login = fs.readFileSync(loginPath, "utf8");
  const common = fs.readFileSync(commonPath, "utf8");
  assert.match(login, /bridge_run_devin auth login --force-manual-token-flow/);
  assert.match(common, /exec devin "\$@"/);
  assert.doesNotMatch(login, /read\s+.*token|printf\s+.*token|echo\s+.*token/i);
});

test("normal live launch uses the strict auth and proxied Devin helpers", () => {
  const launch = fs.readFileSync(launchPath, "utf8");
  assert.match(launch, /up -d network-guard claude-egress-guard/);
  assert.match(launch, /bridge_check_devin_auth/);
  assert.match(launch, /bridge_run_devin models list --format json/);
  assert.doesNotMatch(launch, /\bdevin auth status\b/);
});

test("Claude audit helpers fail closed for missing, empty, partial, or any real-run record", () => {
  const sandboxRoot = path.join(root, ".sandbox");
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const auditRoot = fs.mkdtempSync(path.join(sandboxRoot, "audit-unit-"));
  const auditPath = path.join(auditRoot, "claude-egress.jsonl");
  try {
    assert.notEqual(runCommon("bridge_assert_zero_claude_egress", auditPath).status, 0);
    fs.writeFileSync(auditPath, "");
    assert.equal(runCommon("bridge_assert_zero_claude_egress", auditPath).status, 0);
    fs.writeFileSync(auditPath, '{"hostname":"api.anthropic.com","decision":"deny"}\n');
    assert.notEqual(runCommon("bridge_assert_zero_claude_egress", auditPath).status, 0);

    assert.notEqual(runCommon("bridge_assert_claude_guard_denials", auditPath).status, 0);
    fs.appendFileSync(auditPath, '{"hostname":"claude.ai","decision":"deny"}\n');
    assert.equal(runCommon("bridge_assert_claude_guard_denials", auditPath).status, 0);
    fs.appendFileSync(auditPath, '{"hostname":"example.com","decision":"allow"}\n');
    assert.notEqual(runCommon("bridge_assert_claude_guard_denials", auditPath).status, 0);
  } finally {
    fs.rmSync(auditRoot, { recursive: true, force: true });
  }
});

test("offline and live resets precreate an empty world-writable Claude audit", () => {
  const auditPath = path.join(root, ".sandbox", "evidence", "claude-egress.jsonl");
  for (const resetFunction of ["bridge_reset_e2e_fixture", "bridge_reset_live_fixture"]) {
    const reset = spawnSync(
      "bash",
      ["-c", 'source "$1"; "$2"', "bridge-reset-test", commonPath, resetFunction],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(fs.existsSync(auditPath), true, resetFunction);
    assert.equal(fs.statSync(auditPath).size, 0, resetFunction);
    assert.equal(fs.statSync(auditPath).mode & 0o777, 0o666, resetFunction);
    fs.writeFileSync(auditPath, "record");
  }
});

test("verifier proves audited denials while real E2E gates require zero Claude attempts", () => {
  const verifier = fs.readFileSync(verifierPath, "utf8");
  const mockE2e = fs.readFileSync(mockE2ePath, "utf8");
  const liveE2e = fs.readFileSync(liveE2ePath, "utf8");

  assert.match(verifier, /fetch\("https:\/\/api\.anthropic\.com"/);
  assert.match(verifier, /fetch\("https:\/\/claude\.ai"/);
  assert.match(verifier, /bridge_assert_claude_guard_denials/);
  assert.ok(
    [...verifier.matchAll(/bridge_reset_claude_egress_audit/g)].length >= 2,
    "deliberate proof must reset the audit before and after its own requests"
  );
  assert.match(mockE2e, /bridge_assert_zero_claude_egress/);
  assert.match(liveE2e, /bridge_assert_zero_claude_egress/);
});
