import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { checkConnection } from "./db";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./trpc/router";
import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
// 保留原有 REST API 路由
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
// ===== 拦截 tRPC v11 batch 注册请求，直接处理 =====
app.post("/api/trpc/user.register", async (req, res) => {
  try {
    // 解析 v11 batch 格式
    const batchData = req.body;
    let input: any = {};
    
    // 提取实际数据（兼容 batch 格式）
    if (batchData["0"] && batchData["0"].json) {
      input = batchData["0"].json;
    } else if (batchData.json) {
      input = batchData.json;
    } else {
      input = batchData;
    }

    const { phone, email, password } = input;

    // 验证
    if (!email || !password) {
      return res.status(400).json({
        result: {
          data: {
            json: {
              error: { message: "邮箱和密码必填", code: "BAD_REQUEST" }
            }
          }
        }
      });
    }

    // 检查邮箱是否已存在
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({
        result: {
          data: {
            json: {
              error: { message: "该邮箱已被注册", code: "CONFLICT" }
            }
          }
        }
      });
    }

    // 创建用户
    const passwordHash = await bcrypt.hash(password, 12);
    const displayName = phone || email.split('@')[0] || "用户";

    const result = await db.insert(users).values({
      email,
      passwordHash,
      phone: phone || null,
      name: displayName,
      role: "user",
      membershipTier: "free",
      isActive: 1,
    });

    const insertedId = Number(result[0].insertId);
    const token = jwt.sign(
      { id: insertedId, email, role: "user", membershipTier: "free" },
      process.env.JWT_SECRET || "default-secret",
      { expiresIn: "7d" }
    );

    // 返回 v11 格式的响应
    res.json({
      result: {
        data: {
          json: {
            message: "注册成功",
            token,
            user: {
              id: insertedId,
              email,
              name: displayName,
              role: "user",
              membershipTier: "free",
            },
          }
        }
      }
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      result: {
        data: {
          json: {
            error: { message: "服务器错误", code: "INTERNAL_SERVER_ERROR" }
          }
        }
      }
    });
  }
});
// tRPC 路由（前端使用）- 支持 batching
app.use("/api/trpc", createExpressMiddleware({
  router: appRouter,
  createContext: () => ({}),
  batching: {
    enabled: true,
  },
}));

// 原有 REST API 路由（兼容）
app.get("/api/health", async (req, res) => {
  const dbConnected = await checkConnection();
  res.json({ status: "ok", timestamp: new Date().toISOString(), database: dbConnected ? "connected" : "disconnected" });
});

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/diagnosis", diagnosisRoutes);
app.use("/api/subscription", subscriptionRoutes);

// 404 处理
app.use((req, res) => res.status(404).json({ error: "接口不存在" }));

// 错误处理
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("服务器错误:", err);
  res.status(500).json({ error: "服务器内部错误" });
});

app.listen(PORT, () => {
  console.log(`🚀 AIFFD Backend 运行在端口 ${PORT}`);
  console.log(`🔗 前端地址: ${FRONTEND_URL}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`🔧 tRPC 端点: http://localhost:${PORT}/api/trpc`);
});

