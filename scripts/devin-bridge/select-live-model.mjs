#!/usr/bin/env node
import fs from "node:fs";
import { DEVIN_MODEL_CATALOG } from "../../open-sse/config/providers/registry/devin/catalog.ts";

const document = JSON.parse(fs.readFileSync(0, "utf8"));
const candidates = [];

function collect(value) {
  if (Array.isArray(value)) {
    value.forEach(collect);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      typeof nested === "string" &&
      ["id", "model", "model_id", "slug"].includes(key.toLowerCase()) &&
      /^[a-z0-9][a-z0-9._/-]*$/i.test(nested)
    ) {
      candidates.push(nested);
    }
    collect(nested);
  }
}

collect(document);
const unique = [...new Set(candidates)];
const catalogIds = new Set(DEVIN_MODEL_CATALOG.map((entry) => entry.id));
const available = unique.filter((candidate) => catalogIds.has(candidate));

for (const [name, configured] of [
  ["DEVIN_BRIDGE_SONNET_MODEL", process.env.DEVIN_BRIDGE_SONNET_MODEL],
  ["DEVIN_BRIDGE_OPUS_MODEL", process.env.DEVIN_BRIDGE_OPUS_MODEL],
  ["DEVIN_BRIDGE_HAIKU_MODEL", process.env.DEVIN_BRIDGE_HAIKU_MODEL],
  ["DEVIN_BRIDGE_SUBAGENT_MODEL", process.env.DEVIN_BRIDGE_SUBAGENT_MODEL],
]) {
  if (!configured) continue;
  const prefix = "devin-cli-agentic/";
  const modelId = configured.startsWith(prefix) ? configured.slice(prefix.length) : "";
  if (!modelId || !available.includes(modelId)) {
    throw new Error(`${name} is not a model returned by Devin and present in OmniRoute`);
  }
}

const selected =
  available.find((candidate) => candidate === "swe-1-7") ||
  available.find((candidate) => /swe|claude|gpt|gemini/i.test(candidate)) ||
  available[0];

if (!selected) {
  throw new Error("Devin returned no model identifier present in OmniRoute's Devin catalog");
}
process.stdout.write(selected);
