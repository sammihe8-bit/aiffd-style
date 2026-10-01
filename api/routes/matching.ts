import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "../../db";
import {
  humanStyleProfiles, profileFieldChangeLog,
  fashionItems, fashionItemVariants, fashionItemFieldSources, fashionItemMaterialAttributes,
  matchingRules, matchingReasonCodes, matchingResults,
} from "../../db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";
import {
  ENGINE_VERSION, computeDimension, validateRuleSet, isHardConstraint, itemSourceConfidence,
  HUMAN_SOURCE_CONFIDENCE, HUMAN_NO_RECORD_CONFIDENCE, ITEM_NO_RECORD_CONFIDENCE,
} from "./matching-core";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine V1.0 —— 路由与数据读取
// 计分逻辑全部在 matching-core.ts（纯函数，可离线测试），这里只负责
// 读数据库、调用计分核心、保存 matching_results、返回结果。
//
// 以后新增 Face / Style / Color 等通道：主要是往 matching_rules 加数据，
// 再在 matching-core.ts 的 HUMAN_FIELDS / ITEM_FIELDS 注册新字段。
// ══════════════════════════════════════════════════════════════════

export { ENGINE_VERSION };

const router = Router();

type Profile = typeof humanStyleProfiles.$inferSelect;

async function loadValidatedRules(channel: string) {
  const all = await db.select().from(matchingRules)
    .where(and(eq(matchingRules.channel, channel), eq(matchingRules.isActive, true)));
  const { valid, errors } = validateRuleSet(all);
  return { valid, errors, activeCount: all.length };
}

// ── 数据读取 ─────────────────────────────────────────────────────
async function latestHumanSource(profileId: string, fieldName: string) {
  const rows = await db.select({ source: profileFieldChangeLog.source }).from(profileFieldChangeLog)
    .where(and(eq(profileFieldChangeLog.profileId, profileId), eq(profileFieldChangeLog.fieldName, fieldName)))
    .orderBy(desc(profileFieldChangeLog.id)).limit(1);
  return rows[0]?.source ?? null;
}

async function latestItemSource(itemId: string, variantId: string | null, fieldName: string) {
  // 优先取变体级溯源记录，没有再取商品级
  if (variantId) {
    const v = await db.select().from(fashionItemFieldSources)
      .where(and(eq(fashionItemFieldSources.itemId, itemId), eq(fashionItemFieldSources.variantId, variantId),
        eq(fashionItemFieldSources.fieldName, fieldName)))
      .orderBy(desc(fashionItemFieldSources.id)).limit(1);
    if (v[0]) return v[0];
  }
  const i = await db.select().from(fashionItemFieldSources)
    .where(and(eq(fashionItemFieldSources.itemId, itemId), isNull(fashionItemFieldSources.variantId),
      eq(fashionItemFieldSources.fieldName, fieldName)))
    .orderBy(desc(fashionItemFieldSources.id)).limit(1);
  return i[0] ?? null;
}

async function loadMaterial(itemId: string, variantId: string | null) {
  if (variantId) {
    const v = await db.select().from(fashionItemMaterialAttributes)
      .where(and(eq(fashionItemMaterialAttributes.itemId, itemId), eq(fashionItemMaterialAttributes.variantId, variantId)))
      .limit(1);
    if (v[0]) return v[0];
  }
  const i = await db.select().from(fashionItemMaterialAttributes)
    .where(and(eq(fashionItemMaterialAttributes.itemId, itemId), isNull(fashionItemMaterialAttributes.variantId)))
    .limit(1);
  return i[0] ?? null;
}

// ── 单维度计分 ───────────────────────────────────────────────────
async function scoreChannel(channel: string, profile: Profile, itemId: string, variantId: string | null) {
  const itemRows = await db.select().from(fashionItems).where(eq(fashionItems.itemId, itemId)).limit(1);
  if (itemRows.length === 0) return { error: "商品不存在", status: 404 as const };
  const item = itemRows[0];

  let variant: typeof fashionItemVariants.$inferSelect | null = null;
  if (variantId) {
    const vr = await db.select().from(fashionItemVariants).where(eq(fashionItemVariants.variantId, variantId)).limit(1);
    if (vr.length === 0 || vr[0].itemId !== itemId) return { error: "变体不存在或不属于该商品", status: 404 as const };
    variant = vr[0];
  }
  const material = await loadMaterial(itemId, variantId);

  const { valid: rules, errors: ruleErrors, activeCount } = await loadValidatedRules(channel);
  if (rules.length === 0) return { error: `通道 ${channel} 没有可用的有效规则`, status: 422 as const, ruleErrors };

  const reasonRows = await db.select().from(matchingReasonCodes);
  const reasonDir = new Map(reasonRows.map(r => [r.reasonCode, r.outputDirection as string]));

  const { dimensionResult, detail: coreDetail } = await computeDimension({
    channel, rules, reasonDir,
    profile: profile as unknown as Record<string, unknown>,
    item: item as unknown as Record<string, unknown>,
    material: material as unknown as Record<string, unknown> | null,
    humanConfidence: async (field) => {
      const src = await latestHumanSource(profile.profileId, field);
      return src ? (HUMAN_SOURCE_CONFIDENCE[src] ?? HUMAN_NO_RECORD_CONFIDENCE) : HUMAN_NO_RECORD_CONFIDENCE;
    },
    itemConfidence: async (field) => {
      const src = await latestItemSource(itemId, variantId, field);
      return src ? itemSourceConfidence(src.sourceMethod, src.verifiedStatus) : ITEM_NO_RECORD_CONFIDENCE;
    },
  });

  const detail = {
    ...coreDetail,
    rule_validation_errors: ruleErrors,
    rules_active: activeCount,
    rules_valid: rules.length,
    variant_updated_at: variant?.updatedAt ?? null,
    material_row: material ? (material.variantId ? "variant" : "item") : null,
  };

  // 保存结果；eligibility 与硬约束明细存在 result_detail_json 里，无需迁移
  const resultId = `MR_${randomUUID()}`;
  const { score, data_coverage, rule_coverage, confidence } = dimensionResult;
  await db.insert(matchingResults).values({
    resultId,
    profileId: profile.profileId,
    itemId,
    variantId,
    channel,
    score: score === null ? null : String(score),
    dataCoverage: String(data_coverage),
    ruleCoverage: rule_coverage === null ? null : String(rule_coverage),
    confidence: confidence === null ? null : String(confidence),
    engineVersion: ENGINE_VERSION,
    profileVersion: profile.profileVersion,
    itemUpdatedAt: item.updatedAt,
    resultDetailJson: { ...detail, eligibility: dimensionResult.eligibility },
  });

  return {
    status: 200 as const,
    body: {
      result_id: resultId,
      engine_version: ENGINE_VERSION,
      profile_id: profile.profileId,
      profile_version: profile.profileVersion,
      item_id: itemId,
      variant_id: variantId,
      item_updated_at: item.updatedAt,
      ...dimensionResult,
      detail,
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// 路由
// ══════════════════════════════════════════════════════════════════

const SUPPORTED_CHANNELS = ["body_fit"] as const;

const scoreSchema = z.object({
  itemId: z.string().min(1).max(30),
  variantId: z.string().min(1).max(30).optional(),
  channel: z.enum(SUPPORTED_CHANNELS).default("body_fit"),
});

// POST /score —— 当前登录用户 × 指定商品，计算一个维度的匹配分并保存
router.post("/score", authenticate, async (req: AuthRequest, res) => {
  try {
    const { itemId, variantId, channel } = scoreSchema.parse(req.body);
    const profiles = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.userId, req.user!.id)).limit(1);
    if (profiles.length === 0) return res.status(404).json({ error: "还没有风格档案，请先完成测试" });

    const result = await scoreChannel(channel, profiles[0], itemId, variantId ?? null);
    if (result.status !== 200) return res.status(result.status).json(result);
    res.json(result.body);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "请求参数错误", details: error.errors });
    console.error("Matching score error:", error);
    res.status(500).json({ error: "匹配计算失败" });
  }
});

// GET /results?itemId=xxx —— 查询当前用户的历史匹配结果（最近 20 条）
router.get("/results", authenticate, async (req: AuthRequest, res) => {
  try {
    const profiles = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.userId, req.user!.id)).limit(1);
    if (profiles.length === 0) return res.json({ results: [] });
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : null;
    const cond = itemId
      ? and(eq(matchingResults.profileId, profiles[0].profileId), eq(matchingResults.itemId, itemId))
      : eq(matchingResults.profileId, profiles[0].profileId);
    const rows = await db.select({
      resultId: matchingResults.resultId, itemId: matchingResults.itemId, variantId: matchingResults.variantId,
      channel: matchingResults.channel, score: matchingResults.score, dataCoverage: matchingResults.dataCoverage,
      ruleCoverage: matchingResults.ruleCoverage, confidence: matchingResults.confidence,
      engineVersion: matchingResults.engineVersion, profileVersion: matchingResults.profileVersion,
      calculatedAt: matchingResults.calculatedAt,
    }).from(matchingResults).where(cond).orderBy(desc(matchingResults.id)).limit(20);
    res.json({ results: rows });
  } catch (error) {
    console.error("Matching results error:", error);
    res.status(500).json({ error: "查询匹配结果失败" });
  }
});

// GET /rules/validate?channel=body_fit —— 校验当前 active 规则（③B 验收标准第一条）
router.get("/rules/validate", authenticate, async (req: AuthRequest, res) => {
  try {
    const channel = typeof req.query.channel === "string" ? req.query.channel : "body_fit";
    const { valid, errors, activeCount } = await loadValidatedRules(channel);
    const scoring = valid.filter(r => !isHardConstraint(r));
    const units = new Set(scoring.map(r => `${r.subDimension}|${r.humanField}|${r.itemField}`));
    res.json({
      channel,
      engine_version: ENGINE_VERSION,
      rules_active: activeCount,
      rules_valid: valid.length,
      scoring_rules: scoring.length,
      constraint_rules: valid.length - scoring.length,
      scoring_units: units.size,
      passed: errors.length === 0,
      errors,
    });
  } catch (error) {
    console.error("Matching rule validation error:", error);
    res.status(500).json({ error: "规则校验失败" });
  }
});

export default router;
