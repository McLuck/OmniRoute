import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import {
  buildClaudeSseFrames,
  buildClaudeTextResponse,
  buildClaudeToolUseResponse,
} from "./devin-agentic/anthropicResponse.ts";
import { serializeAnthropicForDevin } from "./devin-agentic/serializer.ts";
import { parseDevinToolRequest } from "./devin-agentic/toolParser.ts";
import { asRecord, DevinAgenticBridgeError, estimateTokens } from "./devin-agentic/types.ts";

type AcpMessage = {
  jsonrpc: "2.0";
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

const CLAUDE_ENV_BLOCKLIST = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function resolveDevinBin(): string {
  const envBin = process.env.CLI_DEVIN_AGENTIC_BIN?.trim() || process.env.CLI_DEVIN_BIN?.trim();
  if (envBin) return envBin;

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const winPath = path.join(localAppData, "devin", "cli", "bin", "devin.exe");
    if (fs.existsSync(winPath)) return winPath;
    return "devin.exe";
  }

  for (const candidate of [
    path.join(os.homedir(), ".local", "share", "devin", "bin", "devin"),
    path.join(os.homedir(), ".devin", "bin", "devin"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "devin";
}

function rpc(method: string, params: unknown, id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

export function assertLocalAcpUrl(url: string): void {
  if (url !== "devin://acp/stdio") {
    throw new DevinAgenticBridgeError(
      "devin-cli-agentic accepts only the local Devin ACP stdio upstream",
      "invalid_acp_upstream",
      500
    );
  }
}

function isIsolatedHome(value: string): boolean {
  return value === "/home/bridge" || value.includes("/.sandbox/");
}

export function buildDevinChildEnv(
  _credentials: ExecuteInput["credentials"],
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = source.DEVIN_AGENTIC_HOME?.trim() || "";
  if (!home || !path.isAbsolute(home) || !isIsolatedHome(home)) {
    throw new DevinAgenticBridgeError(
      "DEVIN_AGENTIC_HOME must be an absolute path inside the bridge sandbox",
      "unsafe_devin_home",
      500
    );
  }

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG || "C.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (source.LC_ALL) env.LC_ALL = source.LC_ALL;
  if (source.TERM) env.TERM = source.TERM;

  for (const key of CLAUDE_ENV_BLOCKLIST) delete env[key];
  return env;
}

function errorBody(error: unknown) {
  const bridge = error instanceof DevinAgenticBridgeError ? error : null;
  return {
    error: {
      message: bridge?.message || (error instanceof Error ? error.message : String(error)),
      type: "devin_agentic_error",
      code: bridge?.code || "devin_agentic_error",
    },
  };
}

async function runAcpTurn(args: {
  devinBin: string;
  env: NodeJS.ProcessEnv;
  model: string;
  promptText: string;
  signal?: AbortSignal | null;
  log?: ExecuteInput["log"];
}) {
  const timeoutMs = Number(process.env.DEVIN_AGENTIC_ACP_TIMEOUT_MS || 120000);
  const child = spawn(args.devinBin, ["acp"], {
    env: args.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let nextId = 1;
  let buffer = "";
  let text = "";
  let initialized = false;
  let sessionCreated = false;
  let sessionId = "";
  let promptRequestId = 0;
  let settled = false;

  return await new Promise<string>((resolve, reject) => {
    const finish = (err: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      if (!child.killed) child.kill("SIGTERM");
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(
        new DevinAgenticBridgeError(`Devin ACP timed out after ${timeoutMs}ms`, "acp_timeout", 504)
      );
    }, timeoutMs);
    timer.unref?.();

    const send = (method: string, params: unknown) => {
      const id = nextId++;
      child.stdin.write(rpc(method, params, id));
      return id;
    };

    args.signal?.addEventListener("abort", () => {
      finish(new DevinAgenticBridgeError("Devin ACP request was cancelled", "acp_cancelled", 499));
    });

    child.on("error", (err) => {
      const message =
        err.message.includes("ENOENT") || err.message.includes("not found")
          ? `Devin CLI not found: ${args.devinBin}. Install the official Devin CLI or set CLI_DEVIN_AGENTIC_BIN.`
          : `Devin CLI spawn error: ${err.message}`;
      finish(new DevinAgenticBridgeError(message, "spawn_failed", 502));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      args.log?.debug?.("DEVIN_AGENTIC", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let msg: AcpMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.error) {
          finish(
            new DevinAgenticBridgeError(
              `Devin ACP error ${msg.error.code}: ${msg.error.message}`,
              "acp_error",
              502
            )
          );
          return;
        }

        if (!initialized && msg.result !== undefined && !msg.method) {
          initialized = true;
          send("session/new", {
            cwd: process.env.DEVIN_BRIDGE_WORKSPACE || process.cwd(),
            mcpServers: [],
            model: args.model || undefined,
          });
          continue;
        }

        if (initialized && !sessionCreated && msg.result !== undefined && !msg.method) {
          sessionId = String(asRecord(msg.result).sessionId || "");
          if (!sessionId) {
            finish(
              new DevinAgenticBridgeError(
                "Devin ACP session/new returned no sessionId",
                "missing_session_id",
                502
              )
            );
            return;
          }
          sessionCreated = true;
          promptRequestId = send("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: args.promptText }],
          });
          continue;
        }

        if (msg.method === "session/update" || msg.method === "$/update") {
          const params = asRecord(msg.params);
          const update = asRecord(params.update);
          const kind = String(update.sessionUpdate || params.type || "");
          if (kind === "agent_message_chunk") {
            text += extractText(update.content);
          } else if (
            kind === "message_delta" ||
            kind === "text_delta" ||
            kind === "content_delta"
          ) {
            text += String(params.content || params.delta || params.text || "");
          }
          continue;
        }

        if (sessionCreated && msg.id === promptRequestId && msg.result !== undefined) {
          const resultText =
            extractText(asRecord(msg.result).content) || extractText(asRecord(msg.result).message);
          finish(null, text || resultText);
        }
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code === 0 && text) finish(null, text);
      else
        finish(
          new DevinAgenticBridgeError(
            `Devin CLI exited before completing the turn with code ${code}`,
            "acp_early_exit",
            502
          )
        );
    });

    send("initialize", {
      protocolVersion: "0.3",
      clientInfo: { name: "omniroute-devin-cli-agentic", version: "1.0" },
      capabilities: {},
    });
  });
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => extractText(item)).join("");
  const record = asRecord(value);
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

export class DevinCliAgenticExecutor extends BaseExecutor {
  constructor() {
    super("devin-cli-agentic", { id: "devin-cli-agentic", baseUrl: "devin://acp/stdio" });
  }

  buildUrl(): string {
    const url = "devin://acp/stdio";
    assertLocalAcpUrl(url);
    return url;
  }

  buildHeaders(): Record<string, string> {
    return {};
  }

  transformRequest(): unknown {
    return null;
  }

  async execute({ model, body, stream, credentials, signal, log }: ExecuteInput) {
    try {
      const prompt = serializeAnthropicForDevin(body);
      const devinBin = resolveDevinBin();
      log?.info?.("DEVIN_AGENTIC", `devin acp → model=${model}, bin=${devinBin}`);

      const text = await runAcpTurn({
        devinBin,
        env: buildDevinChildEnv(credentials),
        model,
        promptText: prompt.text,
        signal,
        log,
      });

      const tool = parseDevinToolRequest(text, prompt.tools);
      const id = `msg_devin_${Date.now()}`;
      const outputTokens = estimateTokens(text);
      const message = tool
        ? buildClaudeToolUseResponse({
            id,
            model,
            tool,
            inputTokens: prompt.inputTokensEstimate,
            outputTokens,
          })
        : buildClaudeTextResponse({
            id,
            model,
            text,
            inputTokens: prompt.inputTokensEstimate,
            outputTokens,
          });

      const responseBody = stream ? buildClaudeSseFrames(message) : JSON.stringify(message);
      return {
        response: new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": stream ? "text/event-stream" : "application/json",
            "Cache-Control": "no-cache",
          },
        }),
        url: "devin://acp/stdio",
        headers: {},
        transformedBody: { model, promptLength: prompt.text.length },
      };
    } catch (error) {
      const bridge = error instanceof DevinAgenticBridgeError ? error : null;
      return {
        response: new Response(JSON.stringify(errorBody(error)), {
          status: bridge?.status || 500,
          headers: { "Content-Type": "application/json" },
        }),
        url: "devin://acp/stdio",
        headers: {},
        transformedBody: { model },
      };
    }
  }
}
