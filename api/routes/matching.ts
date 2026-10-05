import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { db } from "../../db";
import {
  humanStyleProfiles, profileFieldChangeLog,
  fashionItems, fashionItemVariants, fashionItemFieldSources, fashionItemMaterialAttributes,
  matchingRules, matchingReasonCodes, matchingResults,
  profileStyleScores, fashionItemStyleScores,
  fashionVariantColorAttributes, fashionVariantColorIdentity,
} from "../../db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { authenticate, AuthRequest } from "../middleware/auth";
import {
  ENGINE_VERSION, computeDimension, validateRuleSet, isHardConstraint, itemSourceConfidence,
  HUMAN_SOURCE_CONFIDENCE, HUMAN_NO_RECORD_CONFIDENCE, ITEM_NO_RECORD_CONFIDENCE, EngineNumericError,
  channelAppliesTo,
} from "./matching-core";
import { aggregate, parsePriority, SCENARIOS, Dimension, DimensionInput } from "./matching-aggregate";
import { computeStyleFit, STYLE_FIT_CHANNEL, STYLE_FIT_RULE_VERSION, STYLE_FIT_REASONS } from "./matching-style";
import { computeColorFit, COLOR_FIT_CHANNEL, COLOR_FIT_RULE_VERSION, COLOR_FIT_REASONS, VariantResolution } from "./matching-color";
import { normalizeChangeLogFieldName } from "./human-profile-validate";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine V1.0 —— 路由与数据读取
// 计分逻辑全部在 matching-core.ts（纯函数，可离线测试），这里只负责
// 读数据库、调用计分核心、保存 matching_results、返回结果。
//
// 新增通道：往 matching_rules 加数据，在 matching-core.ts 的 HUMAN_FIELDS / ITEM_FIELDS
// 注册新字段，在下面的 SUPPORTED_CHANNELS 加通道名；需要限定品类时在 CHANNEL_CATEGORY_SCOPE 登记。
// 已上线：body_fit（2026-09）、face_fit（2026-10-01）、style_fit（2026-10-03）。
// style_fit 不走规则表，计分在 matching-style.ts（03A Part C）。
// color_fit（2026-10-04，03A Part D V0.1）：计分在 matching-color.ts，参数仍为 provisional，
// 只开放 /score，不加入 /match（见下方 MATCH_CHANNELS）；矩阵定稿为 V1.0 后再加入汇总。
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
// 来源记录一次性批量读取（原来每个字段查一次），按 id 倒序取每个字段的最新一条。
// 字段名经 normalizeChangeLogFieldName 统一（历史行 final_season25 与新行 final_season_25 视为同一字段）
async function loadHumanSources(profileId: string) {
  const rows = await db.select({ fieldName: profileFieldChangeLog.fieldName, source: profileFieldChangeLog.source })
    .from(profileFieldChangeLog)
    .where(eq(profileFieldChangeLog.profileId, profileId))
    .orderBy(desc(profileFieldChangeLog.id));
  const latest = new Map<string, string>();
  for (const r of rows) {
    const name = normalizeChangeLogFieldName(r.fieldName);
    if (!latest.has(name)) latest.set(name, r.source);
  }
  return latest;
}

// 优先取变体级溯源记录，没有再取商品级；其他变体的记录忽略
async function loadItemSources(itemId: string, variantId: string | null) {
  const rows = await db.select().from(fashionItemFieldSources)
    .where(eq(fashionItemFieldSources.itemId, itemId))
    .orderBy(desc(fashionItemFieldSources.id));
  const variantLevel = new Map<string, typeof rows[number]>();
  const itemLevel = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    if (variantId && r.variantId === variantId) { if (!variantLevel.has(r.fieldName)) variantLevel.set(r.fieldName, r); }
    else if (r.variantId === null) { if (!itemLevel.has(r.fieldName)) itemLevel.set(r.fieldName, r); }
  }
  return (field: string) => variantLevel.get(field) ?? itemLevel.get(field) ?? null;
}

// 商品风格分（03A Part C 第二节）：变体不继承商品风格且有自己的行时用变体的行，否则用商品级行，两者不混用
async function loadItemStyleScores(itemId: string, variant: typeof fashionItemVariants.$inferSelect | null) {
  if (variant && variant.inheritsItemStyle === false) {
    const v = await db.select().from(fashionItemStyleScores)
      .where(and(eq(fashionItemStyleScores.itemId, itemId), eq(fashionItemStyleScores.variantId, variant.variantId)));
    if (v.length > 0) return { rows: v, level: "variant" as const };
  }
  const i = await db.select().from(fashionItemStyleScores)
    .where(and(eq(fashionItemStyleScores.itemId, itemId), isNull(fashionItemStyleScores.variantId)));
  return { rows: i, level: "item" as const };
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

// Color Fit 的变体解析（03A Part D 第二节）：传了 variantId 用它（归属已在上面校验）；
// 没传且商品恰有一个变体时自动采用（auto_single）；多个变体不猜（ambiguous）；没有变体（none）
// 返回实际使用的变体行，detail.variant_updated_at 取它的 updatedAt（auto_single 时也有值）
async function resolveColorVariant(itemId: string, variant: typeof fashionItemVariants.$inferSelect | null) {
  if (variant) return { resolution: "explicit" as VariantResolution, variant };
  const vs = await db.select().from(fashionItemVariants)
    .where(eq(fashionItemVariants.itemId, itemId)).limit(2);
  if (vs.length === 0) return { resolution: "none" as VariantResolution, variant: null };
  if (vs.length === 1) return { resolution: "auto_single" as VariantResolution, variant: vs[0] };
  return { resolution: "ambiguous" as VariantResolution, variant: null };
}

// 色彩行只按变体读取（两张表没有商品级的行，不存在回退）；最多取 2 行，用于发现同一变体重复行
async function loadVariantColor(variantId: string | null) {
  if (!variantId) return { attrs: [], ident: [] };
  const attrs = await db.select().from(fashionVariantColorAttributes)
    .where(eq(fashionVariantColorAttributes.variantId, variantId)).limit(2);
  const ident = await db.select().from(fashionVariantColorIdentity)
    .where(eq(fashionVariantColorIdentity.variantId, variantId)).limit(2);
  return { attrs, ident };
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

  // 品类门控（03A Face Fit 第三节）：范围外不计分、不写 matching_results
  if (!channelAppliesTo(channel, item.category)) {
    return { error: `商品品类 ${item.category} 不在 ${channel} 的适用范围内`, status: 422 as const, code: "CATEGORY_OUT_OF_SCOPE" as const };
  }

  const reasonRows = await db.select().from(matchingReasonCodes);
  const reasonDir = new Map(reasonRows.map(r => [r.reasonCode, r.outputDirection as string]));
  const humanSources = await loadHumanSources(profile.profileId);

  let dimensionResult: any;
  let exact: { data_coverage: number };
  let detail: Record<string, unknown>;
  let unitValidationErrorCount: number;
  // 写进 matching_results 的变体：一般就是请求里的 variantId；color_fit 用解析后的实际变体
  let resultVariantId: string | null = variantId;

  if (channel === COLOR_FIT_CHANNEL) {
    // ── Color Fit（03A Part D V0.1）：冷暖 / 季型 / 副气三个单元，参数 provisional ──
    const resolved = await resolveColorVariant(itemId, variant);
    const resolvedVariantId = resolved.variant?.variantId ?? null;
    resultVariantId = resolvedVariantId;
    const { attrs, ident } = await loadVariantColor(resolvedVariantId);
    const itemSourceOf = await loadItemSources(itemId, resolvedVariantId);
    const humanEv = (field: string, value: unknown) => {
      const src = humanSources.get(field);
      return src
        ? { value, confidence: HUMAN_SOURCE_CONFIDENCE[src] ?? HUMAN_NO_RECORD_CONFIDENCE, confidenceSource: "change_log" as const }
        : { value, confidence: HUMAN_NO_RECORD_CONFIDENCE, confidenceSource: "no_record_fallback" as const };
    };
    const itemSrc = (field: string) => {
      const s = itemSourceOf(field);
      return s ? { sourceMethod: s.sourceMethod, verifiedStatus: s.verifiedStatus, confidence: s.confidence } : null;
    };
    const a = attrs.length === 1 ? attrs[0] : null;
    const i = ident.length === 1 ? ident[0] : null;

    const r = computeColorFit({
      variantResolution: resolved.resolution,
      human: {
        warmCool: humanEv("warm_cool", profile.warmCool),
        seasonName: humanEv("season_name", profile.seasonName),
        elementName: humanEv("element_name", profile.elementName),
        seasonElement: profile.seasonElement,
        finalSeason25: profile.finalSeason25,
      },
      item: {
        attributesRows: attrs.length,
        identityRows: ident.length,
        colorTemperature: { value: a?.colorTemperature ?? null, source: itemSrc("color_temperature") },
        seasonName: { value: i?.seasonName ?? null, rowConfidence: i?.colorIdentityConfidence ?? null, source: itemSrc("season_name") },
        elementName: { value: i?.elementName ?? null, rowConfidence: i?.colorIdentityConfidence ?? null, source: itemSrc("element_name") },
        seasonElement: i?.seasonElement ?? null,
        finalSeason25: i?.finalSeason25 ?? null,
      },
      reasonDir,
    });
    dimensionResult = r.dimensionResult;
    exact = r.exact;
    unitValidationErrorCount = r.detail.unit_validation_errors.length;
    detail = {
      ...r.detail,
      requested_variant_id: variantId,
      resolved_variant_id: resolvedVariantId,
      variant_updated_at: resolved.variant?.updatedAt ?? null,
    };
  } else if (channel === STYLE_FIT_CHANNEL) {
    // ── Style Fit（03A Part C）：人侧 13 型概率 × 商品各型适配度 ──
    const humanRows = await db.select().from(profileStyleScores)
      .where(eq(profileStyleScores.profileId, profile.profileId));
    const { rows: itemRows, level } = await loadItemStyleScores(itemId, variant);
    const src = humanSources.get("primary_style");
    const humanConfidence = src ? (HUMAN_SOURCE_CONFIDENCE[src] ?? HUMAN_NO_RECORD_CONFIDENCE) : HUMAN_NO_RECORD_CONFIDENCE;

    const r = computeStyleFit({
      humanRows: humanRows.map(h => ({
        styleCode: h.styleCode, probability: h.probability,
        isPrimary: h.isPrimary, isSecondary: h.isSecondary, engineVersion: h.engineVersion,
      })),
      itemRows: itemRows.map(x => ({
        styleCode: x.styleCode, score: x.score, confidence: x.confidence,
        sourceMethod: x.sourceMethod, verifiedStatus: x.verifiedStatus, isPrimary: x.isPrimary,
      })),
      humanConfidence, reasonDir,
    });
    dimensionResult = r.dimensionResult;
    exact = r.exact;
    unitValidationErrorCount = r.detail.unit_validation_errors.length;
    detail = { ...r.detail, item_style_rows_level: level, variant_updated_at: variant?.updatedAt ?? null };
  } else {
    // ── 规则表维度（body_fit / face_fit）──
    const material = await loadMaterial(itemId, variantId);

    const { valid: rules, errors: ruleErrors, activeCount } = await loadValidatedRules(channel);
    if (rules.length === 0) return { error: `通道 ${channel} 没有可用的有效规则`, status: 422 as const, ruleErrors };

    const itemSourceOf = await loadItemSources(itemId, variantId);

    const r = await computeDimension({
      channel, rules, reasonDir,
      profile: profile as unknown as Record<string, unknown>,
      item: item as unknown as Record<string, unknown>,
      material: material as unknown as Record<string, unknown> | null,
      humanConfidence: async (field) => {
        const src = humanSources.get(field);
        return src ? (HUMAN_SOURCE_CONFIDENCE[src] ?? HUMAN_NO_RECORD_CONFIDENCE) : HUMAN_NO_RECORD_CONFIDENCE;
      },
      itemConfidence: async (field) => {
        const src = itemSourceOf(field);
        return src ? itemSourceConfidence(src.sourceMethod, src.verifiedStatus) : ITEM_NO_RECORD_CONFIDENCE;
      },
    });
    dimensionResult = r.dimensionResult;
    exact = r.exact;
    unitValidationErrorCount = r.detail.unit_validation_errors.length;
    detail = {
      ...r.detail,
      rule_validation_errors: ruleErrors,
      rules_active: activeCount,
      rules_valid: rules.length,
      variant_updated_at: variant?.updatedAt ?? null,
      material_row: material ? (material.variantId ? "variant" : "item") : null,
    };
  }

  // 保存结果；eligibility 与硬约束明细存在 result_detail_json 里，无需迁移
  const resultId = `MR_${randomUUID()}`;
  const { score, data_coverage, rule_coverage, confidence } = dimensionResult;
  await db.insert(matchingResults).values({
    resultId,
    profileId: profile.profileId,
    itemId,
    variantId: resultVariantId,
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

  // 汇总层需要的输入（data_coverage 用未四舍五入的值）
  const aggregateInput: DimensionInput = {
    result_id: resultId,
    score: dimensionResult.score,
    data_coverage: exact.data_coverage,
    rule_coverage: dimensionResult.rule_coverage,
    confidence: dimensionResult.confidence,
    eligibility: dimensionResult.eligibility,
    strengths: dimensionResult.strengths,
    warnings: dimensionResult.warnings,
    unit_validation_error_count: unitValidationErrorCount,
    engine_version: ENGINE_VERSION,
    rule_versions: dimensionResult.rule_versions,
  };

  return {
    status: 200 as const,
    aggregateInput,
    body: {
      result_id: resultId,
      engine_version: ENGINE_VERSION,
      profile_id: profile.profileId,
      profile_version: profile.profileVersion,
      item_id: itemId,
      variant_id: resultVariantId,
      item_updated_at: item.updatedAt,
      ...dimensionResult,
      detail,
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// 路由
// ══════════════════════════════════════════════════════════════════

// /score 可用的维度
const SUPPORTED_CHANNELS = ["body_fit", "face_fit", "style_fit", "color_fit"] as const;
// /match 参与汇总的维度。color_fit 参数仍为 provisional（03A Part D V0.1），暂不加入；
// 矩阵与阈值定稿为 V1.0 后，在这里加上 "color_fit" 即可
const MATCH_CHANNELS = ["body_fit", "face_fit", "style_fit"] as const;

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
    if (error instanceof EngineNumericError) {
      // 只记录字段名，不记录用户数据
      console.error("Matching score numeric error:", error.field);
      return res.status(500).json({ error: "匹配计算失败", code: "ENGINE_NUMERIC_ERROR" });
    }
    console.error("Matching score error:", error);
    res.status(500).json({ error: "匹配计算失败" });
  }
});

// POST /match —— 当前登录用户 × 指定商品，计算 MATCH_CHANNELS 里的维度并按 ③C 汇总
// 目前 body_fit + face_fit + style_fit 参与汇总（默认权重 50%，有效维度最多 3 个）；color_fit 只在 /score 开放。
// 三个维度都有效（data_coverage ≥ 0.30）时才能算出总分，否则 insufficient_coverage（③C 第五节）
const matchSchema = z.object({
  itemId: z.string().min(1).max(30),
  variantId: z.string().min(1).max(30).optional(),
  scenario: z.enum(SCENARIOS).optional(),
  priority: z.unknown().optional(),
});

router.post("/match", authenticate, async (req: AuthRequest, res) => {
  try {
    const { itemId, variantId, scenario, priority: rawPriority } = matchSchema.parse(req.body);
    const priority = parsePriority(rawPriority);
    if (!priority.ok) return res.status(400).json({ error: "请求参数错误", details: priority.error });

    const profiles = await db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.userId, req.user!.id)).limit(1);
    if (profiles.length === 0) return res.status(404).json({ error: "还没有风格档案，请先完成测试" });

    const dimensions: Partial<Record<Dimension, DimensionInput>> = {};
    const skipped: { dimension: string; status: number; error: string; code?: string }[] = [];
    for (const channel of MATCH_CHANNELS) {
      const r = await scoreChannel(channel, profiles[0], itemId, variantId ?? null);
      if (r.status === 404) return res.status(404).json({ error: r.error });
      if (r.status !== 200) {
        skipped.push({ dimension: channel, status: r.status, error: r.error, ...("code" in r ? { code: r.code } : {}) });
        continue;
      }
      dimensions[channel as Dimension] = r.aggregateInput;
    }

    const overall = aggregate({
      dimensions, scenario: scenario ?? null, priority: priority.value,
      profile_version: profiles[0].profileVersion,
    });
    res.json({ item_id: itemId, variant_id: variantId ?? null, profile_id: profiles[0].profileId, ...overall, skipped_dimensions: skipped });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "请求参数错误", details: error.errors });
    if (error instanceof EngineNumericError) {
      // 只记录字段名，不记录用户数据
      console.error("Matching match numeric error:", error.field);
      return res.status(500).json({ error: "匹配计算失败", code: "ENGINE_NUMERIC_ERROR" });
    }
    console.error("Matching match error:", error);
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

    // 公式型维度（style_fit、color_fit）没有规则行，改为校验原因码是否齐全、方向是否正确
    // （03A Part C 第七节、Part D 第七节）；reason_codes 数不是规则数
    const FORMULA_CHANNELS: Record<string, { reasons: readonly { code: string; direction: string }[]; version: string }> = {
      [STYLE_FIT_CHANNEL]: { reasons: STYLE_FIT_REASONS, version: STYLE_FIT_RULE_VERSION },
      [COLOR_FIT_CHANNEL]: { reasons: COLOR_FIT_REASONS, version: COLOR_FIT_RULE_VERSION },
    };
    const formula = Object.prototype.hasOwnProperty.call(FORMULA_CHANNELS, channel) ? FORMULA_CHANNELS[channel] : null;
    if (formula) {
      const rows = await db.select().from(matchingReasonCodes).where(eq(matchingReasonCodes.channel, channel));
      const errors: string[] = [];
      for (const r of formula.reasons) {
        const hit = rows.filter(x => x.reasonCode === r.code);
        if (hit.length === 0) errors.push(`缺少原因码 ${r.code}`);
        else if (hit.length > 1) errors.push(`原因码重复 ${r.code}（${hit.length} 行）`);
        else if (hit[0].outputDirection !== r.direction) errors.push(`${r.code} 方向应为 ${r.direction}，实际 ${hit[0].outputDirection}`);
      }
      const known = new Set<string>(formula.reasons.map(r => r.code));
      for (const x of rows) if (!known.has(x.reasonCode)) errors.push(`多余原因码 ${x.reasonCode}`);
      return res.json({
        channel,
        engine_version: ENGINE_VERSION,
        method: "formula",
        rule_version: formula.version,
        reason_codes_expected: formula.reasons.length,
        reason_codes_found: rows.length,
        passed: errors.length === 0,
        errors,
      });
    }

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
