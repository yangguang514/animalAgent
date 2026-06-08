# AnimalAgent Vercel

这是 AnimalAgent 的独立结构化版本。原项目不会被此目录修改。

## 技术结构

```text
AnimalAgentVercel/
  api/index.js                  # Vercel Function 入口
  server/index.js               # 本地 API 服务
  backend/                      # Agent、服务、仓储和工具
  src/
    components/                 # Vue UI 组件
    composables/                # 会话状态与业务流程
    services/                   # HTTP 与 SSE 客户端
    styles/                     # 全局样式
    utils/                      # Markdown 等工具
  index.html                    # Vite 页面入口
  vite.config.js
  vercel.json
```

## 本地开发

```bash
copy .env.example .env
npm install
npm run dev
```

- 前端：`http://localhost:5173`
- API：`http://localhost:3010`
- Vite 会把 `/api` 请求代理到本地 API。
- API 进程刻意不使用 `node --watch`。流式会话期间自动重启会直接中断 SSE 连接。

本地存储使用：

```env
STORAGE_PROVIDER=json
```

## Vercel 部署

在 Vercel 导入 `AnimalAgentVercel` 目录：

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

生产环境建议：

```env
STORAGE_PROVIDER=postgres
```

同时配置模型、搜索服务以及 Neon Postgres 的连接变量。数据库仓储使用
`@neondatabase/serverless`，支持 `POSTGRES_URL` 或 `DATABASE_URL`。`vercel.json` 会将：

- `/api/*` 转发到 `api/index.js`
- 其他路径交给 Vite 的 `dist/index.html`

流式回答会先创建数据库草稿并在生成过程中增量更新。浏览器刷新会取消上游请求，
但已经生成的内容会保留，消息状态会标记为 `interrupted`。同一会话只允许一个回答同时生成。

模型鲁棒性与成本保护可通过 `LLM_TIMEOUT_MS`、`LLM_MAX_ATTEMPTS`、
`LLM_MAX_OUTPUT_TOKENS`、`LLM_MAX_AGENT_CALLS_PER_TURN` 配置。

## 检查

```bash
npm run check
npm run build
```
