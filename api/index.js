import express from "express";
import { handleApi } from "../backend/routes/apiRoutes.js";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(async (req, res) => {
  try {
    const rewrittenPath = Array.isArray(req.query.path) ? req.query.path.join("/") : req.query.path;
    const originalUrl = req.url;
    req.url = rewrittenPath
      ? `/api/${String(rewrittenPath).replace(/^\/+/, "")}`
      : req.url.startsWith("/api")
        ? req.url
        : `/api${req.url === "/" ? "" : req.url}`;
    const handled = await handleApi(req, res);
    req.url = originalUrl;
    if (!handled && !res.headersSent) {
      res.status(404).json({ error: "Not found" });
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
});

export default app;
