import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";

import { DevinCliAgenticExecutor } from "../../open-sse/executors/devin-cli-agentic.ts";

async function readResponseText(response: Response) {
  return await response.text();
}

function writeMockDevin(tmpDir: string, responseText: string) {
  const framesFile = path.join(tmpDir, "frames.json");
  const scriptFile = path.join(tmpDir, "mock-devin");
  const script = `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const frames = [];
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  frames.push(msg);
  fs.writeFileSync(${JSON.stringify(framesFile)}, JSON.stringify(frames, null, 2));
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_agentic" } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(responseText)} } } }
    }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
  }
});
`;
  writeFileSync(scriptFile, script, { mode: 0o755 });
  return { scriptFile, framesFile };
}

test("DevinCliAgenticExecutor returns Anthropic tool_use JSON and sends ACP frames", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-agentic-"));
  const oldBin = process.env.CLI_DEVIN_AGENTIC_BIN;
  const { scriptFile, framesFile } = writeMockDevin(
    tmpDir,
    '<tool>{"name":"Read","arguments":{"file_path":"src/index.ts"}}</tool>'
  );
  process.env.CLI_DEVIN_AGENTIC_BIN = scriptFile;

  try {
    const executor = new DevinCliAgenticExecutor();
    const result = await executor.execute({
      model: "swe-1-7",
      stream: false,
      credentials: { apiKey: "devin-test" },
      body: {
        messages: [{ role: "user", content: [{ type: "text", text: "Read src/index.ts" }] }],
        tools: [
          {
            name: "Read",
            input_schema: {
              type: "object",
              required: ["file_path"],
              properties: { file_path: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      },
    });

    assert.equal(result.response.status, 200);
    const json = JSON.parse(await readResponseText(result.response));
    assert.equal(json.stop_reason, "tool_use");
    assert.equal(json.content[0].type, "tool_use");
    assert.equal(json.content[0].name, "Read");
    assert.deepEqual(json.content[0].input, { file_path: "src/index.ts" });

    const frames = JSON.parse(fs.readFileSync(framesFile, "utf8"));
    assert.ok(frames.some((frame: { method?: string }) => frame.method === "initialize"));
    assert.ok(frames.some((frame: { method?: string }) => frame.method === "session/new"));
    assert.ok(frames.some((frame: { method?: string }) => frame.method === "session/prompt"));
  } finally {
    if (oldBin === undefined) delete process.env.CLI_DEVIN_AGENTIC_BIN;
    else process.env.CLI_DEVIN_AGENTIC_BIN = oldBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DevinCliAgenticExecutor returns Anthropic SSE for streaming Claude clients", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-agentic-sse-"));
  const oldBin = process.env.CLI_DEVIN_AGENTIC_BIN;
  const { scriptFile } = writeMockDevin(tmpDir, "Done");
  process.env.CLI_DEVIN_AGENTIC_BIN = scriptFile;

  try {
    const executor = new DevinCliAgenticExecutor();
    const result = await executor.execute({
      model: "swe-1-7",
      stream: true,
      credentials: {},
      body: { messages: [{ role: "user", content: [{ type: "text", text: "Say done" }] }] },
    });

    assert.equal(result.response.status, 200);
    const sse = await readResponseText(result.response);
    assert.match(sse, /event: message_start/);
    assert.match(sse, /event: content_block_delta/);
    assert.match(sse, /Done/);
    assert.match(sse, /event: message_stop/);
  } finally {
    if (oldBin === undefined) delete process.env.CLI_DEVIN_AGENTIC_BIN;
    else process.env.CLI_DEVIN_AGENTIC_BIN = oldBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

