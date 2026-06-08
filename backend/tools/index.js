import { registerTool } from "./toolRegistry.js";
import { webSearchTool } from "./webSearchTool.js";

// 集中注册当前后端可用工具；后续新增工具只需要在这里加入定义。
registerTool(webSearchTool);

export { callTool, getTool, listTools, registerTool } from "./toolRegistry.js";
export { WEB_SEARCH_TOOL } from "./webSearchTool.js";
