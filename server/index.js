import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { handleApi } from "../backend/routes/apiRoutes.js";
import { loadEnvFile } from "../backend/config/env.js";

dotenv.config();
await loadEnvFile();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api", async (req, res) => {
  try {
    req.url = `/api${req.url}`;
    const handled = await handleApi(req, res);
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

const port = Number(process.env.PORT || 3010);
app.listen(port, () => {
  console.log(`AnimalAgent API listening on http://localhost:${port}`);
});
