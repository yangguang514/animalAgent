const tools = new Map();

function validateTool(tool) {
  if (!tool || typeof tool !== "object") throw new Error("Tool definition must be an object.");
  if (!tool.name || typeof tool.name !== "string") throw new Error("Tool definition requires a string name.");
  if (typeof tool.execute !== "function") throw new Error(`Tool ${tool.name} requires an execute function.`);
}

// 注册一个工具。后续新增工具时，只需要提供 name/description/execute。
export function registerTool(tool) {
  validateTool(tool);
  tools.set(tool.name, tool);
  return tool;
}

export function getTool(name) {
  return tools.get(name) || null;
}

// 暴露工具元信息，方便未来让 planner 或前端查看当前可用能力。
export function listTools() {
  return [...tools.values()].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }));
}

// 统一工具调用入口：所有工具都返回一致的 ok/result/error 结构。
export async function callTool(name, input = {}, context = {}) {
  const tool = getTool(name);
  const startedAt = Date.now();

  if (!tool) {
    return {
      ok: false,
      tool: name,
      error: `Tool not registered: ${name}`,
      elapsedMs: Date.now() - startedAt
    };
  }

  try {
    const result = await tool.execute(input, context);
    return {
      ok: true,
      tool: name,
      result,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      tool: name,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt
    };
  }
}
