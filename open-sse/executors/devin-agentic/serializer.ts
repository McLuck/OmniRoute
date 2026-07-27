import {
  asRecord,
  DevinAgenticBridgeError,
  estimateTokens,
  type AnthropicTool,
  type DevinPrompt,
} from "./types.ts";

function stringifyContentValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function serializeSystem(system: unknown): string[] {
  if (typeof system === "string" && system.trim()) return [`[System]\n${system}`];
  if (!Array.isArray(system)) return [];

  const parts: string[] = [];
  for (const block of system) {
    const record = asRecord(block);
    if (record.type === "text") {
      parts.push(String(record.text || ""));
    } else if (Object.keys(record).length > 0) {
      throw new DevinAgenticBridgeError(
        `Unsupported Anthropic system block type: ${String(record.type || "unknown")}`,
        "unsupported_system_block"
      );
    }
  }
  return parts.length > 0 ? [`[System]\n${parts.join("\n")}`] : [];
}

function serializeBlock(block: unknown): string {
  const record = asRecord(block);
  const type = String(record.type || "");

  if (type === "text") return String(record.text || "");
  if (type === "thinking") return `[Thinking]\n${String(record.thinking || "")}`;
  if (type === "redacted_thinking") return "[Redacted Thinking]";
  if (type === "tool_use") {
    return [
      "[Assistant Tool Use]",
      `id: ${String(record.id || "")}`,
      `name: ${String(record.name || "")}`,
      "arguments:",
      JSON.stringify(record.input || {}, null, 2),
    ].join("\n");
  }
  if (type === "tool_result") {
    return [
      "[Tool Result]",
      `tool_use_id: ${String(record.tool_use_id || "")}`,
      `is_error: ${record.is_error === true ? "true" : "false"}`,
      "content:",
      stringifyContentValue(record.content),
    ].join("\n");
  }
  if (type === "image") {
    throw new DevinAgenticBridgeError(
      "Anthropic image blocks are not supported by devin-cli-agentic",
      "unsupported_image_block"
    );
  }

  throw new DevinAgenticBridgeError(
    `Unsupported Anthropic content block type: ${type || "unknown"}`,
    "unsupported_content_block"
  );
}

function serializeMessage(message: unknown): string {
  const record = asRecord(message);
  const role = String(record.role || "user");
  const label = role === "assistant" ? "Assistant" : role === "system" ? "System" : "User";
  const content = record.content;

  if (typeof content === "string") return `[${label}]\n${content}`;
  if (!Array.isArray(content)) return `[${label}]\n${stringifyContentValue(content)}`;

  return `[${label}]\n${content.map((block) => serializeBlock(block)).join("\n\n")}`;
}

function normalizeTools(tools: unknown): AnthropicTool[] {
  if (tools == null) return [];
  if (!Array.isArray(tools)) {
    throw new DevinAgenticBridgeError("Anthropic tools must be an array", "invalid_tools");
  }

  return tools.map((tool) => {
    const record = asRecord(tool);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      throw new DevinAgenticBridgeError("Anthropic tool is missing name", "invalid_tool_name");
    }
    return {
      name,
      description: typeof record.description === "string" ? record.description : undefined,
      input_schema: asRecord(record.input_schema),
    };
  });
}

function serializeToolCatalog(tools: AnthropicTool[]): string[] {
  if (tools.length === 0) return [];
  return [
    [
      "[Available Tools]",
      "When a tool is required, respond with exactly one XML-wrapped JSON object:",
      '<tool>{"name":"ToolName","arguments":{}}</tool>',
      "Use only the tools listed below. Do not claim that a tool was executed.",
    ].join("\n"),
    ...tools.map((tool) =>
      [
        `[Tool] ${tool.name}`,
        tool.description ? `description: ${tool.description}` : "description:",
        "input_schema:",
        JSON.stringify(tool.input_schema || { type: "object", properties: {} }, null, 2),
      ].join("\n")
    ),
  ];
}

export function serializeAnthropicForDevin(body: unknown): DevinPrompt {
  const record = asRecord(body);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const tools = normalizeTools(record.tools);
  const sections: string[] = [
    ...serializeSystem(record.system),
    ...serializeToolCatalog(tools),
    ...messages.map((message) => serializeMessage(message)),
  ].filter((section) => section.trim().length > 0);

  if (sections.length === 0) {
    throw new DevinAgenticBridgeError("Anthropic request contains no messages", "empty_messages");
  }

  const text = sections.join("\n\n---\n\n");
  return { text, tools, inputTokensEstimate: estimateTokens(text) };
}
