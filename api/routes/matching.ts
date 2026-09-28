import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "../../db";
import {
  humanStyleProfiles, profileFieldChangeLog,
  fashionItems, fashionItemVariants, fashionItemFieldSources, fashionItemMaterialAttributes,
  matchingRules, matchingReasonCodes, matchingResults,
  MatchingRule,
} from "../../db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine V1.0
// 对齐 ③B《Matching Scoring Rules V1.0》修正版（2026-09-25）
//
// 计分流程：
//   1. 读取 active 规则 → 逐条做字段/枚举校验，不合法的规则不参与计分
//   2. 按"子维度 × Human 字段 × Item 字段"划分计分单元
//      单元权重 = 子维度权重（rule_weight）÷ 该子维度的单元数
//   3. 每个单元判定状态：
//        explicit_rule    —— 双方有数据且命中一条规则
//        default_neutral  —— 双方有数据但没有规则命中，按 0.50 计分
//        not_applicable   —— 任一侧缺失 / uncertain，不进分母
//        validation_error —— 同一单元命中多条规则，跳过并记录
//   4. score / data_coverage / rule_coverage / confidence 分开计算
//   5. 结果写入 matching_results，API 返回标准 Dimension Result
//
// 以后新增 Face / Style / Color 等通道：主要是往 matching_rules 加数据，
// 再在下面的 HUMAN_FIELDS / ITEM_FIELDS 注册新字段，计分逻辑不需要重写。
// ══════════════════════════════════════════════════════════════════

const router = Router();

export const ENGINE_VERSION = "matching_v1.0";

// ── match_type + strength → compatibility（③B 第二节）──────────────
const COMPATIBILITY: Record<string, number> = {
  "positive:high": 1.0,
  "positive:medium": 0.8,
  "positive:low": 0.65,
  "neutral:": 0.5,
  "penalty:low": 0.35,
  "penalty:medium": 0.2,
  "penalty:high": 0.0,
};
const DEFAULT_NEUTRAL = 0.5;

function compatibilityOf(matchType: string, strength: string | null): number | undefined {
  return COMPATIBILITY[`${matchType}:${matchType === "neutral" ? "" : strength ?? ""}`];
}

// ── 分数区间（③B 第十六节）────────────────────────────────────────
function scoreBand(score: number | null): { band: string; label: string } | null {
  if (score === null) return null;
  if (score >= 90) return { band: "very_high_match", label: "非常协调" };
  if (score >= 80) return { band: "high_match", label: "很适合" };
  if (score >= 70) return { band: "good_match", label: "比较适合" };
  if (score >= 60) return { band: "conditional_match", label: "有条件适合" };
  if (score >= 50) return { band: "neutral", label: "中性/需要结合需求" };
  if (score >= 35) return { band: "weak_match", label: "需要调整" };
  return { band: "strong_conflict", label: "存在明显冲突" };
}

// ── 字段注册表 ───────────────────────────────────────────────────
// 合法值直接取自 db/schema.ts 的枚举定义，schema 是唯一来源，不在这里重复维护。
// waist_type 在数据库里是 text 列（前端存 JSON 数组），所以合法值只能在这里声明。
type Profile = typeof humanStyleProfiles.$inferSelect;

const HUMAN_FIELDS: Record<string, { key: keyof Profile; values: readonly string[]; multi?: boolean }> = {
  bone_scale: { key: "boneScale", values: humanStyleProfiles.boneScale.enumValues },
  shoulder_line_direction: { key: "shoulderLineDirection", values: humanStyleProfiles.shoulderLineDirection.enumValues },
  shoulder_shape: { key: "shoulderShape", values: humanStyleProfiles.shoulderShape.enumValues },
  waist_type: { key: "waistType", values: ["细", "匀", "直", "宽"], multi: true },
  waist_length: { key: "waistLength", values: humanStyleProfiles.waistLength.enumValues },
  body_shape: { key: "bodyShape", values: humanStyleProfiles.bodyShape.enumValues },
  limb_length: { key: "limbLength", values: humanStyleProfiles.limbLength.enumValues },
  flesh_texture: { key: "fleshTexture", values: humanStyleProfiles.fleshTexture.enumValues },
};

type ItemSource = "item" | "material";
const ITEM_FIELDS: Record<string, { source: ItemSource; key: string; values: readonly string[] }> = {
  visual_volume: { source: "item", key: "visualVolume", values: fashionItems.visualVolume.enumValues },
  shoulder_structure: { source: "item", key: "shoulderStructure", values: fashionItems.shoulderStructure.enumValues },
  waist_structure: { source: "item", key: "waistStructure", values: fashionItems.waistStructure.enumValues },
  silhouette: { source: "item", key: "silhouette", values: fashionItems.silhouette.enumValues },
  garment_length: { source: "item", key: "garmentLength", values: fashionItems.garmentLength.enumValues },
  structure_level: { source: "item", key: "structureLevel", values: fashionItems.structureLevel.enumValues },
  drape_level: { source: "material", key: "drapeLevel", values: fashionItemMaterialAttributes.drapeLevel.enumValues },
};

// "不确定"一律视为缺失（③B 第七节）
const UNCERTAIN_VALUES = new Set(["不确定", "uncertain"]);

// ── 置信度映射（③B 第八节 + 2026-09-25 补充确认）──────────────────
const HUMAN_SOURCE_CONFIDENCE: Record<string, number> = {
  body_test: 0.8, face_test: 0.8, color_test: 0.8, fashion_preference_test: 0.8, quarterly_retest: 0.8,
  user_manual_edit: 0.9,
  stylist_correction: 0.95,
  ai_reassessment: 0.7, behavior_tracking: 0.7, feedback_submission: 0.7,
};
const HUMAN_NO_RECORD_CONFIDENCE = 0.8;
const ITEM_NO_RECORD_CONFIDENCE = 0.7;

function itemSourceConfidence(sourceMethod: string, verifiedStatus: string): number | "rejected" {
  if (verifiedStatus === "rejected") return "rejected";
  const verified = verifiedStatus === "verified" || verifiedStatus === "corrected";
  switch (sourceMethod) {
    case "stylist": return 0.95;
    case "brand_source": return 0.9;
    case "manual_operator": return 0.8;
    case "ai_image_analysis":
    case "ai_text_analysis": return verified ? 0.85 : 0.7;
    // 溯源表没有记录推导用了哪些输入，无法取"最弱输入"，V1.0 按 0.70 兜底
    case "system_inference": return 0.7;
    default: return ITEM_NO_RECORD_CONFIDENCE;
  }
}

// ── 工具函数 ─────────────────────────────────────────────────────
// 兼容 JSON 列（驱动返回数组）和文本列（返回字符串）两种情况
function toStringArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
      } catch { return [s]; }
    }
    return [s];
  }
  return [String(v)];
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// ── 规则校验（③B 第四节）──────────────────────────────────────────
type ValidationError = { rule_id: string; problem: string };

function validateRule(rule: MatchingRule): string[] {
  const problems: string[] = [];
  const h = HUMAN_FIELDS[rule.humanField];
  const it = ITEM_FIELDS[rule.itemField];
  if (!h) problems.push(`未注册的 human_field: ${rule.humanField}`);
  if (!it) problems.push(`未注册的 item_field: ${rule.itemField}`);
  if (h) {
    for (const v of toStringArray(rule.humanValue)) {
      if (UNCERTAIN_VALUES.has(v)) problems.push(`human_value 为不确定值: ${v}`);
      else if (!h.values.includes(v)) problems.push(`human_value 非法: ${v}`);
    }
  }
  if (it) {
    for (const v of toStringArray(rule.itemValue)) {
      if (v !== "*" && !it.values.includes(v)) problems.push(`item_value 非法: ${v}`);
    }
  }
  if (rule.matchType !== "hard_constraint" && compatibilityOf(rule.matchType, rule.strength) === undefined) {
    problems.push(`match_type/strength 组合无效: ${rule.matchType}/${rule.strength}`);
  }
  if (rule.matchType === "hard_constraint" && !rule.constraintScope) {
    problems.push("hard_constraint 缺少 constraint_scope");
  }
  if (rule.ruleWeight === null || rule.ruleWeight === undefined) problems.push("缺少 rule_weight");
  return problems;
}

async function loadValidatedRules(channel: string) {
  const all = await db.select().from(matchingRules)
    .where(and(eq(matchingRules.channel, channel), eq(matchingRules.isActive, true)));
  const valid: MatchingRule[] = [];
  const errors: ValidationError[] = [];
  for (const r of all) {
    const problems = validateRule(r);
    if (problems.length > 0) problems.forEach(p => errors.push({ rule_id: r.ruleId, problem: p }));
    else valid.push(r);
  }
  // 同一子维度的 rule_weight 必须一致（它表示的是子维度权重）
  const weightBySub = new Map<string, Set<string>>();
  for (const r of valid) {
    if (!weightBySub.has(r.subDimension)) weightBySub.set(r.subDimension, new Set());
    weightBySub.get(r.subDimension)!.add(String(r.ruleWeight));
  }
  for (const [sub, ws] of weightBySub) {
    if (ws.size > 1) errors.push({ rule_id: `(${sub})`, problem: `同一子维度 rule_weight 不一致: ${[...ws].join(", ")}` });
  }
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

// ── 核心计分 ─────────────────────────────────────────────────────
type UnitStatus = "explicit_rule" | "default_neutral" | "not_applicable" | "validation_error";

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
  const reasonDir = new Map(reasonRows.map(r => [r.reasonCode, r.outputDirection]));

  // 划分计分单元
  const unitMap = new Map<string, MatchingRule[]>();
  for (const r of rules) {
    const key = `${r.subDimension}|${r.humanField}|${r.itemField}`;
    if (!unitMap.has(key)) unitMap.set(key, []);
    unitMap.get(key)!.push(r);
  }
  const unitsPerSub = new Map<string, number>();
  for (const key of unitMap.keys()) {
    const sub = key.split("|")[0];
    unitsPerSub.set(sub, (unitsPerSub.get(sub) ?? 0) + 1);
  }

  // 置信度缓存，避免同一字段重复查询
  const humanConfCache = new Map<string, number>();
  const itemConfCache = new Map<string, number | "rejected">();

  const units: any[] = [];
  const ruleResults: any[] = [];
  const strengths = new Set<string>();
  const warnings = new Set<string>();
  let totalW = 0, applicableW = 0, explicitW = 0, scoreSum = 0, confSum = 0;
  const unitValidationErrors: any[] = [];

  for (const [key, unitRules] of unitMap) {
    const [subDimension, humanField, itemField] = key.split("|");
    const subWeight = Number(unitRules[0].ruleWeight);
    const w = subWeight / unitsPerSub.get(subDimension)!;
    totalW += w;

    const hDef = HUMAN_FIELDS[humanField];
    const iDef = ITEM_FIELDS[itemField];

    // Human 侧取值
    const rawHuman = toStringArray(profile[hDef.key]);
    const humanVals = rawHuman.filter(v => !UNCERTAIN_VALUES.has(v) && hDef.values.includes(v));

    // Item 侧取值
    const rawItem = iDef.source === "material"
      ? (material as Record<string, unknown> | null)?.[iDef.key]
      : (item as Record<string, unknown>)[iDef.key];
    let itemVal = rawItem === null || rawItem === undefined || rawItem === "" ? null : String(rawItem);
    if (itemVal !== null && (UNCERTAIN_VALUES.has(itemVal) || !iDef.values.includes(itemVal))) itemVal = null;

    // Item 置信度（rejected 视为缺失）
    let itemConf: number | "rejected" | undefined = itemConfCache.get(itemField);
    if (itemConf === undefined && itemVal !== null) {
      const src = await latestItemSource(itemId, variantId, itemField);
      itemConf = src ? itemSourceConfidence(src.sourceMethod, src.verifiedStatus) : ITEM_NO_RECORD_CONFIDENCE;
      itemConfCache.set(itemField, itemConf);
    }
    if (itemConf === "rejected") itemVal = null;

    const base = {
      sub_dimension: subDimension, human_field: humanField, item_field: itemField,
      unit_weight: round(w, 3),
      human_value: rawHuman.length === 0 ? null : (hDef.multi ? rawHuman : rawHuman[0]),
      item_value: rawItem ?? null,
    };

    if (humanVals.length === 0 || itemVal === null) {
      units.push({
        ...base, status: "not_applicable" as UnitStatus,
        reason: humanVals.length === 0 ? "human_missing_or_uncertain" : (itemConf === "rejected" ? "item_rejected" : "item_missing_or_uncertain"),
      });
      continue;
    }

    // Human 置信度
    let humanConf = humanConfCache.get(humanField);
    if (humanConf === undefined) {
      const src = await latestHumanSource(profile.profileId, humanField);
      humanConf = src ? (HUMAN_SOURCE_CONFIDENCE[src] ?? HUMAN_NO_RECORD_CONFIDENCE) : HUMAN_NO_RECORD_CONFIDENCE;
      humanConfCache.set(humanField, humanConf);
    }
    const conf = Math.min(humanConf, itemConf as number);

    const hits = unitRules.filter(r => {
      const hv = toStringArray(r.humanValue);
      const iv = toStringArray(r.itemValue);
      return humanVals.some(v => hv.includes(v)) && (iv.includes("*") || iv.includes(itemVal!));
    });

    if (hits.length > 1) {
      // 同一单元命中多条规则：不应发生，跳过并记录，不让整个请求失败
      const err = { ...base, status: "validation_error" as UnitStatus, reason: "multiple_rules_hit", rule_ids: hits.map(h => h.ruleId) };
      units.push(err);
      unitValidationErrors.push(err);
      console.warn("[matching] 计分单元命中多条规则:", JSON.stringify(err));
      continue;
    }

    applicableW += w;
    confSum += conf * w;

    if (hits.length === 0) {
      scoreSum += DEFAULT_NEUTRAL * w;
      units.push({ ...base, status: "default_neutral" as UnitStatus, compatibility: DEFAULT_NEUTRAL, contribution: round(DEFAULT_NEUTRAL * w, 3), confidence: conf });
      continue;
    }

    const r = hits[0];
    const c = compatibilityOf(r.matchType, r.strength)!;
    scoreSum += c * w;
    explicitW += w;

    // neutral 命中不输出解释文案；positive → strengths，penalty → warnings
    if (r.reasonCode && r.matchType !== "neutral") {
      const dir = reasonDir.get(r.reasonCode);
      if (dir === "strength") strengths.add(r.reasonCode);
      else if (dir === "warning") warnings.add(r.reasonCode);
    }

    const ruleResult = {
      rule_id: r.ruleId, dimension: channel, match_type: r.matchType, strength: r.strength,
      compatibility: c, rule_weight: round(w, 3), contribution: round(c * w, 3),
      reason_code: r.reasonCode, human_value: base.human_value, item_value: itemVal,
      confidence: conf, match_status: "explicit_rule", rule_version: r.ruleVersion,
    };
    ruleResults.push(ruleResult);
    units.push({ ...base, status: "explicit_rule" as UnitStatus, rule_id: r.ruleId, compatibility: c, contribution: round(c * w, 3), confidence: conf });
  }

  const score = applicableW > 0 ? round((scoreSum / applicableW) * 100, 2) : null;
  const dataCoverage = totalW > 0 ? round(applicableW / totalW, 3) : 0;
  const ruleCoverage = applicableW > 0 ? round(explicitW / applicableW, 3) : null;
  const confidence = applicableW > 0 ? round(confSum / applicableW, 3) : null;

  const dimensionResult = {
    dimension: channel,
    score,
    score_band: scoreBand(score),
    data_coverage: dataCoverage,
    rule_coverage: ruleCoverage,
    confidence,
    strengths: [...strengths],
    warnings: [...warnings],
    rules_applied: ruleResults.length,
    default_neutral_units: units.filter(u => u.status === "default_neutral").length,
    units_skipped: units.filter(u => u.status === "not_applicable" || u.status === "validation_error").length,
  };

  const detail = {
    rule_results: ruleResults,
    units,
    rule_validation_errors: ruleErrors,
    unit_validation_errors: unitValidationErrors,
    rules_active: activeCount,
    rules_valid: rules.length,
    variant_updated_at: variant?.updatedAt ?? null,
    material_row: material ? (material.variantId ? "variant" : "item") : null,
  };

  // 保存结果（③B 第十三节）
  const resultId = `MR_${randomUUID()}`;
  await db.insert(matchingResults).values({
    resultId,
    profileId: profile.profileId,
    itemId,
    variantId,
    channel,
    score: score === null ? null : String(score),
    dataCoverage: String(dataCoverage),
    ruleCoverage: ruleCoverage === null ? null : String(ruleCoverage),
    confidence: confidence === null ? null : String(confidence),
    engineVersion: ENGINE_VERSION,
    profileVersion: profile.profileVersion,
    itemUpdatedAt: item.updatedAt,
    resultDetailJson: detail,
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
    const units = new Set(valid.map(r => `${r.subDimension}|${r.humanField}|${r.itemField}`));
    res.json({
      channel,
      engine_version: ENGINE_VERSION,
      rules_active: activeCount,
      rules_valid: valid.length,
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
