import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import { styleDiagnoses, styleSystems } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();

const diagnosisSchema = z.object({
  skinTone: z.enum(["warm", "cool", "neutral"]).optional(),
  seasonType: z.enum(["spring", "summer", "autumn", "winter"]).optional(),
  primaryStyle: z.string().min(1),
  secondaryStyle: z.string().optional(),
  colorPalette: z.string().optional(),
  forbiddenColors: z.string().optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
});

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = diagnosisSchema.parse(req.body);
    const result = await db.insert(styleDiagnoses).values({
      userId: req.user!.id,
      skinTone: data.skinTone || null,
      seasonType: data.seasonType || null,
      primaryStyle: data.primaryStyle,
      secondaryStyle: data.secondaryStyle || null,
      colorPalette: data.colorPalette || null,
      forbiddenColors: data.forbiddenColors || null,
      confidenceScore: data.confidenceScore !== undefined ? String(data.confidenceScore) : null,
    });
    res.status(201).json({ message: "诊断结果已保存", id: Number(result[0].insertId) });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    res.status(500).json({ error: "保存诊断失败" });
  }
});

router.get("/styles", async (req, res) => {
  try {
    const styles = await db.select().from(styleSystems).where(eq(styleSystems.isActive, 1)).orderBy(styleSystems.sortOrder);
    res.json(styles);
  } catch (error) {
    res.status(500).json({ error: "获取风格列表失败" });
  }
});

router.get("/my", authenticate, async (req: AuthRequest, res) => {
  try {
    const diagnoses = await db.select().from(styleDiagnoses).where(eq(styleDiagnoses.userId, req.user!.id)).orderBy(desc(styleDiagnoses.createdAt));
    res.json(diagnoses);
  } catch (error) {
    res.status(500).json({ error: "获取诊断历史失败" });
  }
});

export default router;
