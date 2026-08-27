import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import { testProgress } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();

const testTypeEnum = z.enum(["body", "style", "color", "fashion"]);

const saveSchema = z.object({
  testType: testTypeEnum,
  status: z.enum(["in_progress", "completed"]),
  data: z.record(z.any()), // 前端传完整快照对象，后端只当 JSON blob 存，不关心内部字段
});

// 保存/更新进度（每个用户 + 每种测试类型只保留一条最新记录，upsert）
router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const { testType, status, data } = saveSchema.parse(req.body);
    const userId = req.user!.id;

    const existing = await db
      .select({ id: testProgress.id })
      .from(testProgress)
      .where(and(eq(testProgress.userId, userId), eq(testProgress.testType, testType)))
      .limit(1);

    const dataJson = JSON.stringify(data);

    if (existing.length > 0) {
      await db.update(testProgress)
        .set({ status, dataJson })
        .where(eq(testProgress.id, existing[0].id));
      return res.json({ message: "进度已更新" });
    }

    await db.insert(testProgress).values({ userId, testType, status, dataJson });
    res.status(201).json({ message: "进度已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save test progress error:", error);
    res.status(500).json({ error: "保存进度失败" });
  }
});

// 读取某种测试类型当前登录用户的最新进度（没有记录时返回 null，不算错误）
router.get("/:testType", authenticate, async (req: AuthRequest, res) => {
  try {
    const testType = testTypeEnum.parse(req.params.testType);
    const userId = req.user!.id;

    const rows = await db
      .select()
      .from(testProgress)
      .where(and(eq(testProgress.userId, userId), eq(testProgress.testType, testType)))
      .limit(1);

    if (rows.length === 0) return res.json({ progress: null });

    const row = rows[0];
    let data: unknown = null;
    try { data = JSON.parse(row.dataJson); } catch { data = null; }

    res.json({
      progress: { status: row.status, data, updatedAt: row.updatedAt },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "无效的测试类型" });
    console.error("Get test progress error:", error);
    res.status(500).json({ error: "获取进度失败" });
  }
});

// 清除进度（"重新测试"时调用，避免旧存档和新一轮答案混在一起）
router.delete("/:testType", authenticate, async (req: AuthRequest, res) => {
  try {
    const testType = testTypeEnum.parse(req.params.testType);
    const userId = req.user!.id;
    await db.delete(testProgress).where(and(eq(testProgress.userId, userId), eq(testProgress.testType, testType)));
    res.json({ message: "进度已清除" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "无效的测试类型" });
    console.error("Delete test progress error:", error);
    res.status(500).json({ error: "清除进度失败" });
  }
});

export default router;
