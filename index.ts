import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { checkConnection } from "./db";

import authRoutes from "./api/routes/auth";
import userRoutes from "./api/routes/user";
import diagnosisRoutes from "./api/routes/diagnosis";
import subscriptionRoutes from "./api/routes/subscription";

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://aiffd.com";

app.use(helmet());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (req, res) => {
  const dbConnected = await checkConnection();
  res.json({ status: "ok", timestamp: new Date().toISOString(), database: dbConnected ? "connected" : "disconnected" });
});

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/diagnosis", diagnosisRoutes);
app.use("/api/subscription", subscriptionRoutes);

app.use((req, res) => res.status(404).json({ error: "接口不存在" }));
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("服务器错误:", err);
  res.status(500).json({ error: "服务器内部错误" });
});

app.listen(PORT, () => {
  console.log(`🚀 AIFFD Backend 运行在端口 ${PORT}`);
  console.log(`🔗 前端地址: ${FRONTEND_URL}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
});

export default app;
