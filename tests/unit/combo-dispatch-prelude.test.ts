/**
 * Direct unit coverage for open-sse/services/combo/dispatchPrelude.ts — the
 * dispatch branches extracted out of handleComboChat (#3501 decomposition).
 *
 * The contract every one of these helpers shares is the fall-through protocol:
 * return a Response when the branch OWNS the request, return null to let
 * handleComboChat continue to the next branch and ultimately to the normal
 * target iteration loop. A helper that returned a Response where it used to
 * fall through (or vice versa) would silently bypass the whole combo strategy,
 * so the null cases are asserted as deliberately as the dispatching ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-prelude-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-prelude-test-secret";

const {
  normalizeNestedComboMode,
  tryFusionDispatch,
  tryPinnedModelDispatch,
  tryPipelineDispatch,
  tryRuntimeUnitDispatch,
} = await import("../../open-sse/services/combo/dispatchPrelude.ts");
const { resolveComboSetupConfig } = await import("../../open-sse/services/comboConfig.ts");
const core = await import("../../src/lib/db/core.ts");

type ComboInput = Parameters<typeof resolveComboSetupConfig>[0];

function okResponse(content: string): Response {
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeLog() {
  const records: Array<{ level: string; scope: string; msg: string }> = [];
  const cap = (level: string) => (scope: string, msg: string) => {
    records.push({ level, scope, msg: String(msg) });
  };
  return {
    log: { info: cap("info"), warn: cap("warn"), debug: cap("debug"), error: cap("error") },
    records,
  };
}

function setup(combo: ComboInput) {
  const { log, records } = makeLog();
  return {
    log,
    records,
    combo,
    config: resolveComboSetupConfig(combo, {}),
    body: { messages: [{ role: "user", content: "hi" }] } as Record<string, unknown>,
  };
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("normalizeNestedComboMode: only the literal 'execute' opts into execute mode", () => {
  assert.equal(normalizeNestedComboMode("execute"), "execute");
  assert.equal(normalizeNestedComboMode("flatten"), "flatten");
  assert.equal(normalizeNestedComboMode(undefined), "flatten");
  assert.equal(normalizeNestedComboMode(null), "flatten");
  assert.equal(normalizeNestedComboMode("Execute"), "flatten");
  assert.equal(normalizeNestedComboMode(true), "flatten");
});

test("tryPipelineDispatch: falls through (null) for every non-pipeline strategy", async () => {
  for (const strategy of ["priority", "weighted", "round-robin", "auto", "fusion"]) {
    const ctx = setup({ name: "c", strategy, models: [{ model: "p/a" }], config: {} });
    const res = await tryPipelineDispatch({
      body: ctx.body,
      combo: ctx.combo,
      config: ctx.config,
      strategy,
      handleSingleModelWithTimeout: async () => okResponse("nope"),
      log: ctx.log,
    });
    assert.equal(res, null, `strategy ${strategy} must fall through`);
  }
});

test("tryPipelineDispatch: threads combo.models as ordered steps for the pipeline strategy", async () => {
  const ctx = setup({
    name: "chain",
    strategy: "pipeline",
    models: [{ model: "p/first" }, { model: "p/second", prompt: "refine" }],
    config: {},
  });
  const seen: string[] = [];
  const res = await tryPipelineDispatch({
    body: ctx.body,
    combo: ctx.combo,
    config: ctx.config,
    strategy: "pipeline",
    handleSingleModelWithTimeout: async (_body, modelStr) => {
      seen.push(modelStr);
      return okResponse(`out:${modelStr}`);
    },
    log: ctx.log,
  });
  assert.ok(res, "pipeline strategy must own the request");
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["p/first", "p/second"]);
});

test("tryFusionDispatch: falls through for non-fusion strategies but still emits the #6455 warn", async () => {
  const ctx = setup({
    name: "fusion-free",
    strategy: "priority",
    models: [{ model: "p/a" }],
    config: { judgeModel: "auto/claude-opus" },
  });
  const res = await tryFusionDispatch({
    body: ctx.body,
    combo: ctx.combo,
    cfg: ctx.config as unknown as Record<string, unknown>,
    config: ctx.config,
    strategy: "priority",
    allCombos: [],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    runCombo: async () => okResponse("recursed"),
  });
  assert.equal(res, null, "non-fusion strategy must fall through to the target loop");
  const warns = ctx.records.filter((r) => r.level === "warn" && r.msg.includes("judgeModel"));
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /#6455/);
});

test("tryFusionDispatch: silent fall-through when a non-fusion combo sets no fusion keys", async () => {
  const ctx = setup({
    name: "plain",
    strategy: "priority",
    models: [{ model: "p/a" }],
    config: {},
  });
  const res = await tryFusionDispatch({
    body: ctx.body,
    combo: ctx.combo,
    cfg: ctx.config as unknown as Record<string, unknown>,
    config: ctx.config,
    strategy: "priority",
    allCombos: [],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    runCombo: async () => okResponse("recursed"),
  });
  assert.equal(res, null);
  assert.equal(
    ctx.records.filter((r) => r.msg.includes("judgeModel") || r.msg.includes("fusionTuning"))
      .length,
    0
  );
});

test("tryFusionDispatch: owns the request and synthesizes for the fusion strategy", async () => {
  const ctx = setup({
    name: "real-fusion",
    strategy: "fusion",
    models: [{ model: "p/panelA" }, { model: "p/panelB" }],
    config: { judgeModel: "p/judge" },
  });
  const dispatched: string[] = [];
  const res = await tryFusionDispatch({
    body: ctx.body,
    combo: ctx.combo,
    cfg: ctx.config as unknown as Record<string, unknown>,
    config: ctx.config,
    strategy: "fusion",
    allCombos: [],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async (_body, modelStr) => {
      dispatched.push(modelStr);
      return okResponse(`panel:${modelStr}`);
    },
    log: ctx.log,
    runCombo: async () => okResponse("recursed"),
  });
  assert.ok(res, "fusion strategy must own the request");
  assert.ok(dispatched.includes("p/panelA") && dispatched.includes("p/panelB"));
});

test("tryRuntimeUnitDispatch: falls through when the combo has no executable combo-ref", async () => {
  const ctx = setup({
    name: "flat",
    strategy: "priority",
    models: [{ model: "p/a" }, { model: "p/b" }],
    config: { nestedComboMode: "execute" },
  });
  const res = await tryRuntimeUnitDispatch({
    body: ctx.body,
    combo: ctx.combo,
    config: ctx.config,
    strategy: "priority",
    allCombos: [ctx.combo],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    settings: {},
    runCombo: async () => okResponse("recursed"),
  });
  assert.equal(res, null);
});

const LEAF_COMBO: ComboInput = {
  name: "leaf",
  strategy: "priority",
  models: [{ model: "p/leaf" }],
  config: {},
};
const COMBO_REF_STEP = { kind: "combo-ref", comboName: "leaf" };

/**
 * Positive control for the two fall-through assertions below: with the SAME
 * combo-ref fixture, execute mode + a simple strategy really does reach
 * executeRuntimeUnitCombo. Without this, a malformed combo-ref fixture would
 * make the null assertions pass vacuously.
 */
test("tryRuntimeUnitDispatch: owns the request in execute mode with a simple strategy", async () => {
  const ctx = setup({
    name: "parent",
    strategy: "priority",
    models: [COMBO_REF_STEP],
    config: { nestedComboMode: "execute" },
  });
  let recursedInto: string | null = null;
  const res = await tryRuntimeUnitDispatch({
    body: ctx.body,
    combo: ctx.combo,
    config: ctx.config,
    strategy: "priority",
    allCombos: [ctx.combo, LEAF_COMBO],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    settings: {},
    runCombo: async (options) => {
      recursedInto = options.combo.name;
      return okResponse("recursed");
    },
  });
  assert.ok(res, "execute mode + priority must dispatch the combo-ref as a black-box unit");
  assert.equal(recursedInto, "leaf", "the referenced combo must be executed recursively");
});

test("tryRuntimeUnitDispatch: falls through in flatten mode even when a combo-ref is present", async () => {
  const ctx = setup({
    name: "parent",
    strategy: "priority",
    models: [COMBO_REF_STEP],
    // no nestedComboMode ⇒ defaults to "flatten"
    config: {},
  });
  let recursed = false;
  const res = await tryRuntimeUnitDispatch({
    body: ctx.body,
    combo: ctx.combo,
    config: ctx.config,
    strategy: "priority",
    allCombos: [ctx.combo, LEAF_COMBO],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    settings: {},
    runCombo: async () => {
      recursed = true;
      return okResponse("recursed");
    },
  });
  assert.equal(res, null, "flatten mode must leave combo-refs to the normal target machinery");
  assert.equal(recursed, false);
});

test("tryRuntimeUnitDispatch: falls through for strategies outside the simple-execute set", async () => {
  const ctx = setup({
    name: "parent",
    strategy: "auto",
    models: [COMBO_REF_STEP],
    config: { nestedComboMode: "execute" },
  });
  let recursed = false;
  const res = await tryRuntimeUnitDispatch({
    body: ctx.body,
    combo: ctx.combo,
    config: ctx.config,
    strategy: "auto",
    allCombos: [ctx.combo, LEAF_COMBO],
    handleSingleModel: async () => okResponse("x"),
    handleSingleModelWithTimeout: async () => okResponse("x"),
    log: ctx.log,
    settings: {},
    runCombo: async () => {
      recursed = true;
      return okResponse("recursed");
    },
  });
  assert.equal(res, null, "'auto' needs the full target machinery, not runtime-unit dispatch");
  assert.equal(recursed, false);
});

test("tryPinnedModelDispatch: drops a stale pin (not in combo) and falls through with a warn", async () => {
  const ctx = setup({
    name: "pinned-combo",
    strategy: "priority",
    models: [{ model: "p/live" }],
    config: {},
  });
  let dispatched = false;
  const res = await tryPinnedModelDispatch({
    body: ctx.body,
    combo: ctx.combo,
    pinnedModel: "p/removed-last-week",
    allCombos: [ctx.combo],
    config: ctx.config,
    clientRequestedStream: false,
    handleSingleModelWithTimeout: async () => {
      dispatched = true;
      return okResponse("should not happen");
    },
    log: ctx.log,
  });
  assert.equal(res, null, "a stale pin must fall through to the strategy");
  assert.equal(dispatched, false, "a stale pin must never be dispatched");
  const warns = ctx.records.filter((r) => r.level === "warn" && r.msg.includes("Stale"));
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /p\/removed-last-week/);
  assert.match(warns[0].msg, /pinned-combo/);
});

test("tryPinnedModelDispatch: drops the pin when every connection for its provider is down", async () => {
  const ctx = setup({
    name: "pinned-combo",
    strategy: "priority",
    models: [{ model: "p/live" }],
    config: {},
  });
  let dispatched = false;
  // allCombos empty ⇒ not authoritative ⇒ the in-combo check is skipped and the
  // health gate decides. No provider connections exist in this temp DB, so the
  // pin is durably unhealthy and must be dropped rather than pounded.
  const res = await tryPinnedModelDispatch({
    body: ctx.body,
    combo: ctx.combo,
    pinnedModel: "p/live",
    allCombos: [],
    config: ctx.config,
    clientRequestedStream: false,
    handleSingleModelWithTimeout: async () => {
      dispatched = true;
      return okResponse("should not happen");
    },
    log: ctx.log,
  });
  assert.equal(res, null);
  assert.equal(dispatched, false);
  const warns = ctx.records.filter(
    (r) => r.level === "warn" && r.msg.includes("durably unhealthy")
  );
  assert.equal(warns.length, 1);
});
