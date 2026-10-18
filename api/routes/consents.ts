import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import { userConsents } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";
import { consentInputSchema, resolveConsentedAt } from "./consents-validate";

// 同意记录（2026-10-18）：只追加，不修改、不删除。
// 用户每次提交（含日后撤回研究授权等变更）都新增一行，最新一行即当前状态，历史行保留作为审计证据。
const router = Router();

// GET /me —— 当前用户最新一条同意记录；没有时返回 null
router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const rows = await db.select().from(userConsents)
      .where(eq(userConsents.userId, req.user!.id))
      .orderBy(desc(userConsents.id))
      .limit(1);
    res.json({ consent: rows[0] ?? null });
  } catch (error) {
    console.error("Get consent error:", error);
    res.status(500).json({ error: "读取同意记录失败" });
  }
});

// POST / —— 新增一条同意记录
router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const input = consentInputSchema.parse(req.body);
    const consentedAt = resolveConsentedAt(input, new Date());
    if (input.source === "local_backfill") {
      if (!consentedAt) return res.status(400).json({ error: "补传同意记录必须提供原始同意时间 consentedAt" });
      // 补传只在该用户还没有任何服务端记录时接受，避免旧的本机记录覆盖用户之后的新选择
      const existing = await db.select({ id: userConsents.id }).from(userConsents)
        .where(eq(userConsents.userId, req.user!.id)).limit(1);
      if (existing.length > 0) return res.status(409).json({ error: "服务端已有同意记录，不再接受补传", code: "CONSENT_EXISTS" });
    }
    await db.insert(userConsents).values({
      userId: req.user!.id,
      ageAndResearchAck: input.ageAndResearchAck,
      privacyAck: input.privacyAck,
      photoConsent: input.photoConsent,
      researchDataConsent: input.researchDataConsent,
      policyVersion: input.policyVersion,
      consentedAt,
      source: input.source,
    });
    res.status(201).json({ message: "同意记录已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message, details: error.errors });
    console.error("Save consent error:", error);
    res.status(500).json({ error: "保存同意记录失败" });
  }
});

export default router;
