import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import {
  humanStyleProfiles, profileStyleScores, profileFieldChangeLog,
  profileLifestyleScenarios, profileItemPreferences, profileVisualStylePreferences,
  profileColorSignals,
} from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();

// ══════════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════════

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

function formatProfileId(insertedId: number): string {
  return `AIFFD_PROFILE_${String(insertedId).padStart(6, "0")}`;
}

async function getOrCreateProfile(userId: number) {
  const existing = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];

  const result = await db.insert(humanStyleProfiles).values({
    userId,
    profileId: "PENDING",
  });
  const insertedId = Number(result[0].insertId);
  const profileId = formatProfileId(insertedId);
  await db.update(humanStyleProfiles).set({ profileId }).where(eq(humanStyleProfiles.id, insertedId));

  const created = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.id, insertedId)).limit(1);
  return created[0];
}

const PATCHABLE_FIELDS = [
  "ageRange", "heightRange",
  "boneScale", "boneRoundness", "boneWidth", "shoulderShape", "waistType", "waistLength",
  "chestProtrude", "hipProtrude", "limbLength", "handFootSize", "bodyShape", "fleshTexture",
  "mouthWidth", "mouthFullness", "cheekContour", "cheekFullness", "cheekboneProminence",
  "cheekboneShape", "chinLength", "chinShape", "eyeSize", "eyeShape", "eyeSpacing",
  "noseSize", "noseShape", "noseProjection", "jawline", "faceLine",
  "faceShape", "faceSharpnessLabel", "faceSharpnessScore", "faceSharpnessConfidence",
  "primaryStyle", "secondaryStyle", "confidenceScore", "styleElement",
  "warmCool", "valueLevel", "saturationLevel", "seasonName", "seasonElement", "elementName", "finalSeason25",
  "aspiredStylePrimary", "aspiredStyleSecondary", "currentStyle", "currentAspiredStyleGap",
  "rejectedStyleCodes", "colorPreferences", "fabricPreferences",
  "budgetLevel", "budgetMin", "budgetMax", "currency", "priceSensitivity",
  "viewCount", "favoriteCount", "clickCount", "externalClickCount", "purchaseCount", "lastActiveAt",
  "outfitPhotoCount", "avgSatisfactionScore", "latestSelfRating", "latestStylistRating",
] as const

const patchSchema = z.object({
  patch: z.record(z.any()),
  source: z.enum([
    "body_test", "face_test", "color_test", "fashion_preference_test",
    "user_manual_edit", "behavior_tracking", "feedback_submission",
    "stylist_correction", "quarterly_retest", "ai_reassessment",
  ]),
  reason: z.string().max(255).optional(),
  changedByUserId: z.number().int().optional(),
})

function stringifyFieldValue(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

// GET /me —— 获取当前用户完整档案（活档案 + 各子表聚合）
router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const profile = await getOrCreateProfile(req.user!.id)

    const [styleScores, lifestyleScenarios, itemPreferences, visualStylePreferences, colorSignals] = await Promise.all([
      db.select().from(profileStyleScores).where(eq(profileStyleScores.profileId, profile.profileId)),
      db.select().from(profileLifestyleScenarios).where(eq(profileLifestyleScenarios.profileId, profile.profileId)),
      db.select().from(profileItemPreferences).where(eq(profileItemPreferences.profileId, profile.profileId)),
      db.select().from(profileVisualStylePreferences).where(eq(profileVisualStylePreferences.profileId, profile.profileId)),
      db.select().from(profileColorSignals).where(eq(profileColorSignals.profileId, profile.profileId)),
    ])

    res.json({ profile, styleScores, lifestyleScenarios, itemPreferences, visualStylePreferences, colorSignals })
  } catch (error) {
    console.error("Get human profile error:", error)
    res.status(500).json({ error: "获取档案失败" })
  }
})

// PATCH /me —— 更新档案字段，核心逻辑：字段级变更日志
router.patch("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const { patch, source, reason, changedByUserId } = patchSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    const validKeys = Object.keys(patch).filter(k => (PATCHABLE_FIELDS as readonly string[]).includes(k))
    if (validKeys.length === 0) {
      return res.status(400).json({ error: "没有提供任何可更新的字段" })
    }

    const changes: { fieldName: string; oldValue: string; newValue: string }[] = []
    const updateData: Record<string, unknown> = {}
    for (const key of validKeys) {
      const oldVal = (profile as Record<string, unknown>)[key]
      let newVal = patch[key]
      if (Array.isArray(newVal) || (typeof newVal === "object" && newVal !== null)) {
        newVal = JSON.stringify(newVal)
      }
      const oldStr = stringifyFieldValue(oldVal)
      const newStr = stringifyFieldValue(newVal)
      if (oldStr === newStr) continue

      updateData[key] = newVal
      changes.push({ fieldName: toSnakeCase(key), oldValue: oldStr, newValue: newStr })
    }

    if (changes.length === 0) {
      return res.json({ message: "没有字段发生变化", profile })
    }

    const newVersion = profile.profileVersion + 1
    updateData.profileVersion = newVersion
    updateData.lastUpdatedSource = source

    await db.update(humanStyleProfiles).set(updateData).where(eq(humanStyleProfiles.id, profile.id))

    const changedByUid = changedByUserId ?? req.user!.id
    for (const change of changes) {
      await db.insert(profileFieldChangeLog).values({
        profileId: profile.profileId,
        profileVersion: newVersion,
        fieldName: change.fieldName,
        oldValue: change.oldValue,
        newValue: change.newValue,
        reason: reason ?? null,
        source,
        changedByUserId: changedByUid,
      })
    }

    const updated = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.id, profile.id)).limit(1)
    res.json({ message: `已更新 ${changes.length} 个字段`, profile: updated[0], changedFields: changes.map(c => c.fieldName) })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Patch human profile error:", error)
    res.status(500).json({ error: "更新档案失败" })
  }
})

// GET /me/history —— 查看档案变更历史
router.get("/me/history", authenticate, async (req: AuthRequest, res) => {
  try {
    const profile = await getOrCreateProfile(req.user!.id)
    const history = await db.select().from(profileFieldChangeLog)
      .where(eq(profileFieldChangeLog.profileId, profile.profileId))
    history.sort((a, b) => b.profileVersion - a.profileVersion || b.id - a.id)
    res.json({ history })
  } catch (error) {
    console.error("Get profile history error:", error)
    res.status(500).json({ error: "获取档案历史失败" })
  }
})

// POST /me/style-scores —— 整体替换 13 型概率分布
const styleScoresSchema = z.object({
  scores: z.array(z.object({
    styleCode: z.string(),
    probability: z.number().min(0).max(1),
    isPrimary: z.boolean().optional(),
    isSecondary: z.boolean().optional(),
  })),
})
router.post("/me/style-scores", authenticate, async (req: AuthRequest, res) => {
  try {
    const { scores } = styleScoresSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    await db.delete(profileStyleScores).where(eq(profileStyleScores.profileId, profile.profileId))
    for (const s of scores) {
      await db.insert(profileStyleScores).values({
        profileId: profile.profileId,
        styleCode: s.styleCode,
        probability: String(s.probability),
        isPrimary: s.isPrimary ?? false,
        isSecondary: s.isSecondary ?? false,
      })
    }
    res.json({ message: "风格概率分布已更新", count: scores.length })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Save style scores error:", error)
    res.status(500).json({ error: "保存风格概率失败" })
  }
})

// POST /me/lifestyle-scenarios —— 整体替换生活场景权重
const lifestyleScenariosSchema = z.object({
  scenarios: z.array(z.object({
    scenarioParent: z.enum(["work", "social", "travel", "casual", "formal", "other"]),
    scenarioType: z.enum(["predefined", "custom"]),
    scenarioName: z.string().max(100).optional(),
    isFocus: z.boolean().optional(),
    weight: z.number().min(0).max(1),
  })),
})
router.post("/me/lifestyle-scenarios", authenticate, async (req: AuthRequest, res) => {
  try {
    const { scenarios } = lifestyleScenariosSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    await db.delete(profileLifestyleScenarios).where(eq(profileLifestyleScenarios.profileId, profile.profileId))
    for (const s of scenarios) {
      await db.insert(profileLifestyleScenarios).values({
        profileId: profile.profileId,
        scenarioParent: s.scenarioParent,
        scenarioType: s.scenarioType,
        scenarioName: s.scenarioName ?? null,
        isFocus: s.isFocus ?? false,
        weight: String(s.weight),
      })
    }
    res.json({ message: "生活场景权重已更新", count: scenarios.length })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Save lifestyle scenarios error:", error)
    res.status(500).json({ error: "保存生活场景失败" })
  }
})

// POST /me/item-preferences —— upsert 单条单品偏好
const itemPreferenceSchema = z.object({
  itemType: z.string().max(50),
  preferenceLevel: z.enum(["like", "neutral", "dislike"]),
})
router.post("/me/item-preferences", authenticate, async (req: AuthRequest, res) => {
  try {
    const { itemType, preferenceLevel } = itemPreferenceSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    const existing = await db.select().from(profileItemPreferences)
      .where(and(eq(profileItemPreferences.profileId, profile.profileId), eq(profileItemPreferences.itemType, itemType)))
      .limit(1)

    if (existing.length > 0) {
      await db.update(profileItemPreferences).set({ preferenceLevel }).where(eq(profileItemPreferences.id, existing[0].id))
    } else {
      await db.insert(profileItemPreferences).values({ profileId: profile.profileId, itemType, preferenceLevel })
    }
    res.json({ message: "单品偏好已保存" })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Save item preference error:", error)
    res.status(500).json({ error: "保存单品偏好失败" })
  }
})

// POST /me/visual-style-preferences —— upsert 单条视觉风格偏好
const visualStylePreferenceSchema = z.object({
  visualStyleTag: z.string().max(50),
  preferenceLevel: z.enum(["like", "neutral", "dislike"]),
})
router.post("/me/visual-style-preferences", authenticate, async (req: AuthRequest, res) => {
  try {
    const { visualStyleTag, preferenceLevel } = visualStylePreferenceSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    const existing = await db.select().from(profileVisualStylePreferences)
      .where(and(eq(profileVisualStylePreferences.profileId, profile.profileId), eq(profileVisualStylePreferences.visualStyleTag, visualStyleTag)))
      .limit(1)

    if (existing.length > 0) {
      await db.update(profileVisualStylePreferences).set({ preferenceLevel }).where(eq(profileVisualStylePreferences.id, existing[0].id))
    } else {
      await db.insert(profileVisualStylePreferences).values({ profileId: profile.profileId, visualStyleTag, preferenceLevel })
    }
    res.json({ message: "视觉风格偏好已保存" })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Save visual style preference error:", error)
    res.status(500).json({ error: "保存视觉风格偏好失败" })
  }
})

// POST /me/color-signals —— 新增一条色彩原始信号观测记录
const colorSignalSchema = z.object({
  signalType: z.enum(["skin_tone", "hair_color", "iris_color"]),
  value: z.string().max(50),
  sourceMethod: z.enum(["questionnaire", "ai_vision", "stylist_manual"]),
  confidence: z.number().min(0).max(1).optional(),
})
const COLOR_SIGNAL_FIELD_MAP: Record<string, "skinTone" | "hairColor" | "irisColor"> = {
  skin_tone: "skinTone", hair_color: "hairColor", iris_color: "irisColor",
}
const SOURCE_METHOD_TO_CHANGE_SOURCE: Record<string, string> = {
  questionnaire: "color_test", ai_vision: "ai_reassessment", stylist_manual: "stylist_correction",
}

router.post("/me/color-signals", authenticate, async (req: AuthRequest, res) => {
  try {
    const { signalType, value, sourceMethod, confidence } = colorSignalSchema.parse(req.body)
    const profile = await getOrCreateProfile(req.user!.id)

    await db.update(profileColorSignals)
      .set({ isPrimary: false })
      .where(and(eq(profileColorSignals.profileId, profile.profileId), eq(profileColorSignals.signalType, signalType)))

    await db.insert(profileColorSignals).values({
      profileId: profile.profileId,
      signalType, value, sourceMethod,
      confidence: confidence !== undefined ? String(confidence) : null,
      isPrimary: true,
    })

    const cacheField = COLOR_SIGNAL_FIELD_MAP[signalType]
    const oldVal = stringifyFieldValue((profile as Record<string, unknown>)[cacheField])
    if (oldVal !== value) {
      const newVersion = profile.profileVersion + 1
      await db.update(humanStyleProfiles)
        .set({ [cacheField]: value, profileVersion: newVersion, lastUpdatedSource: SOURCE_METHOD_TO_CHANGE_SOURCE[sourceMethod] as any })
        .where(eq(humanStyleProfiles.id, profile.id))
      await db.insert(profileFieldChangeLog).values({
        profileId: profile.profileId,
        profileVersion: newVersion,
        fieldName: signalType,
        oldValue: oldVal,
        newValue: value,
        reason: `色彩信号观测（来源：${sourceMethod}）`,
        source: SOURCE_METHOD_TO_CHANGE_SOURCE[sourceMethod] as any,
        changedByUserId: req.user!.id,
      })
    }

    res.json({ message: "色彩信号已记录" })
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message })
    console.error("Save color signal error:", error)
    res.status(500).json({ error: "保存色彩信号失败" })
  }
})

export default router
