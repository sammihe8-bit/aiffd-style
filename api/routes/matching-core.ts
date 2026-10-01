import {
  humanStyleProfiles, fashionItems, fashionItemMaterialAttributes, MatchingRule,
} from "../../db/schema";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine V1.0 —— 纯计分核心（不访问数据库，可单独测试）
// 对齐 ③B 三次修正版 + ③C V1.0（2026-09-30）
//
// 计分流程：
//   1. 规则逐条做字段/枚举校验，不合法的规则不参与
//   2. 规则分两组：
//        计分规则  —— positive / neutral / penalty，进入计分单元
//        硬约束    —— hard_constraint，不进入任何计分单元和分母，
//                     只用于判定 purchase / recommendation / styling 三项资格（③C 第八节）
//   3. 按"子维度 × Human 字段 × Item 字段"划分计分单元
//      单元权重 = 子维度权重（rule_weight）÷ 该子维度的单元数
//   4. 每个单元判定状态：
//        explicit_rule    —— 双方有数据且命中一条规则
//        default_neutral  —— 双方有数据但没有规则命中，按 0.50 计分
//        not_applicable   —— 任一侧缺失 / uncertain，不进分母
//        validation_error —— 单选字段多值或非法值，或同一单元命中多条规则；跳过并记录
//   5. score / data_coverage / rule_coverage / confidence 分开计算
// ══════════════════════════════════════════════════════════════════

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
export const DEFAULT_NEUTRAL = 0.5;

export function compatibilityOf(matchType: string, strength: string | null): number | undefined {
  return COMPATIBILITY[`${matchType}:${matchType === "neutral" ? "" : strength ?? ""}`];
}

export const isHardConstraint = (r: MatchingRule) => r.matchType === "hard_constraint";

// ── 分数区间（③C 第十节，左闭右开）──────────────────────────────────
export function scoreBand(score: number | null): { band: string; label: string } | null {
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
// 合法值取自 db/schema.ts 的枚举定义。
// waist_type 在数据库里是 text 列（前端存 JSON 数组），数据库层没有约束，
// 产品已确认为单选（2026-09-30），所以标记 runtimeSingleSelect，由引擎做运行时校验。
type Profile = typeof humanStyleProfiles.$inferSelect;
type HumanFieldDef = { key: keyof Profile; values: readonly string[]; runtimeSingleSelect?: boolean };

export const HUMAN_FIELDS: Record<string, HumanFieldDef> = {
  bone_scale: { key: "boneScale", values: humanStyleProfiles.boneScale.enumValues },
  shoulder_line_direction: { key: "shoulderLineDirection", values: humanStyleProfiles.shoulderLineDirection.enumValues },
  shoulder_shape: { key: "shoulderShape", values: humanStyleProfiles.shoulderShape.enumValues },
  waist_type: { key: "waistType", values: ["细", "匀", "直", "宽"], runtimeSingleSelect: true },
  waist_length: { key: "waistLength", values: humanStyleProfiles.waistLength.enumValues },
  body_shape: { key: "bodyShape", values: humanStyleProfiles.bodyShape.enumValues },
  limb_length: { key: "limbLength", values: humanStyleProfiles.limbLength.enumValues },
  flesh_texture: { key: "fleshTexture", values: humanStyleProfiles.fleshTexture.enumValues },
};

type ItemSource = "item" | "material";
export const ITEM_FIELDS: Record<string, { source: ItemSource; key: string; values: readonly string[] }> = {
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

// ── 置信度映射（③B 第九节 / ③C 第九节）─────────────────────────────
export const HUMAN_SOURCE_CONFIDENCE: Record<string, number> = {
  body_test: 0.8, face_test: 0.8, color_test: 0.8, fashion_preference_test: 0.8, quarterly_retest: 0.8,
  user_manual_edit: 0.9,
  stylist_correction: 0.95,
  ai_reassessment: 0.7, behavior_tracking: 0.7, feedback_submission: 0.7,
};
export const HUMAN_NO_RECORD_CONFIDENCE = 0.8;
export const ITEM_NO_RECORD_CONFIDENCE = 0.7;

export function itemSourceConfidence(sourceMethod: string, verifiedStatus: string): number | "rejected" {
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
export function toStringArray(v: unknown): string[] {
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

export const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// ── Human 侧取值 ─────────────────────────────────────────────────
// 单选的运行时校验字段（waist_type），③C 第七节：
//   单个合法值              → ok
//   null / 空数组 / 不确定   → missing（not_applicable）
//   多个值                  → invalid（validation_error），不任取首值
//   非法值                  → invalid（validation_error），不静默过滤
// 数据库 enum 列：值域已由数据库保证，沿用原逻辑（过滤不确定值）。
export type HumanRead =
  | { kind: "ok"; values: string[] }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "single_select_multiple_values" | "illegal_value"; raw: string[] };

export function readHumanValue(def: HumanFieldDef, raw: unknown): HumanRead {
  const arr = toStringArray(raw);
  if (def.runtimeSingleSelect) {
    if (arr.length === 0) return { kind: "missing" };
    if (arr.length > 1) return { kind: "invalid", reason: "single_select_multiple_values", raw: arr };
    const v = arr[0];
    if (UNCERTAIN_VALUES.has(v)) return { kind: "missing" };
    if (!def.values.includes(v)) return { kind: "invalid", reason: "illegal_value", raw: arr };
    return { kind: "ok", values: [v] };
  }
  const vals = arr.filter(v => !UNCERTAIN_VALUES.has(v) && def.values.includes(v));
  return vals.length === 0 ? { kind: "missing" } : { kind: "ok", values: vals };
}

function readItemValue(
  def: { source: ItemSource; key: string; values: readonly string[] },
  item: Record<string, unknown>, material: Record<string, unknown> | null,
): { raw: unknown; value: string | null } {
  const raw = def.source === "material" ? material?.[def.key] : item[def.key];
  let value = raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (value !== null && (UNCERTAIN_VALUES.has(value) || !def.values.includes(value))) value = null;
  return { raw: raw ?? null, value };
}

function ruleHits(r: MatchingRule, humanVals: string[], itemVal: string): boolean {
  const hv = toStringArray(r.humanValue);
  const iv = toStringArray(r.itemValue);
  return humanVals.some(v => hv.includes(v)) && (iv.includes("*") || iv.includes(itemVal));
}

// ── 规则校验（③B 第四节）──────────────────────────────────────────
export type RuleValidationError = { rule_id: string; problem: string };

export function validateRule(rule: MatchingRule): string[] {
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
  if (isHardConstraint(rule)) {
    // 硬约束不参与计分，不需要 compatibility 和 rule_weight
    if (!rule.constraintScope) problems.push("hard_constraint 缺少 constraint_scope");
  } else {
    if (compatibilityOf(rule.matchType, rule.strength) === undefined) {
      problems.push(`match_type/strength 组合无效: ${rule.matchType}/${rule.strength}`);
    }
    if (rule.ruleWeight === null || rule.ruleWeight === undefined) problems.push("缺少 rule_weight");
  }
  return problems;
}

// 逐条校验 + 规则集层面的校验（同一子维度的计分规则 rule_weight 必须一致）
export function validateRuleSet(all: MatchingRule[]) {
  const valid: MatchingRule[] = [];
  const errors: RuleValidationError[] = [];
  for (const r of all) {
    const problems = validateRule(r);
    if (problems.length > 0) problems.forEach(p => errors.push({ rule_id: r.ruleId, problem: p }));
    else valid.push(r);
  }
  const weightBySub = new Map<string, Set<string>>();
  for (const r of valid) {
    if (isHardConstraint(r)) continue;
    if (!weightBySub.has(r.subDimension)) weightBySub.set(r.subDimension, new Set());
    weightBySub.get(r.subDimension)!.add(String(Number(r.ruleWeight)));
  }
  for (const [sub, ws] of weightBySub) {
    if (ws.size > 1) errors.push({ rule_id: `(${sub})`, problem: `同一子维度 rule_weight 不一致: ${[...ws].join(", ")}` });
  }
  return { valid, errors };
}

// ── 核心计分 ─────────────────────────────────────────────────────
export type UnitStatus = "explicit_rule" | "default_neutral" | "not_applicable" | "validation_error";
export type ConstraintStatus = "triggered" | "clear" | "not_evaluable" | "validation_error";
export type Eligibility = { purchase: boolean; recommendation: boolean; styling: boolean };

export interface ComputeInput {
  channel: string;
  rules: MatchingRule[];                          // 已通过 validateRuleSet 的规则（含硬约束）
  reasonDir: Map<string, string>;                 // reason_code → strength / warning
  profile: Record<string, unknown>;
  item: Record<string, unknown>;
  material: Record<string, unknown> | null;
  humanConfidence: (humanField: string) => Promise<number>;
  itemConfidence: (itemField: string) => Promise<number | "rejected">;
  log?: (msg: string, payload: unknown) => void;
}

export async function computeDimension(input: ComputeInput) {
  const { channel, rules, reasonDir, profile, item, material } = input;
  const log = input.log ?? ((m, p) => console.warn(m, JSON.stringify(p)));

  // 置信度按字段缓存，避免重复查询
  const hCache = new Map<string, number>();
  const iCache = new Map<string, number | "rejected">();
  const humanConf = async (f: string) => {
    if (!hCache.has(f)) hCache.set(f, await input.humanConfidence(f));
    return hCache.get(f)!;
  };
  const itemConf = async (f: string) => {
    if (!iCache.has(f)) iCache.set(f, await input.itemConfidence(f));
    return iCache.get(f)!;
  };

  const scoringRules = rules.filter(r => !isHardConstraint(r));
  const constraintRules = rules.filter(isHardConstraint);

  // ── 1. 计分（只用计分规则，硬约束完全不进入）──
  const unitMap = new Map<string, MatchingRule[]>();
  for (const r of scoringRules) {
    const key = `${r.subDimension}|${r.humanField}|${r.itemField}`;
    if (!unitMap.has(key)) unitMap.set(key, []);
    unitMap.get(key)!.push(r);
  }
  const unitsPerSub = new Map<string, number>();
  for (const key of unitMap.keys()) {
    const sub = key.split("|")[0];
    unitsPerSub.set(sub, (unitsPerSub.get(sub) ?? 0) + 1);
  }

  const units: any[] = [];
  const ruleResults: any[] = [];
  const strengths = new Set<string>();
  const warnings = new Set<string>();
  const unitValidationErrors: any[] = [];
  let totalW = 0, applicableW = 0, explicitW = 0, scoreSum = 0, confSum = 0;

  for (const [key, unitRules] of unitMap) {
    const [subDimension, humanField, itemField] = key.split("|");
    const w = Number(unitRules[0].ruleWeight) / unitsPerSub.get(subDimension)!;
    totalW += w;

    const hDef = HUMAN_FIELDS[humanField];
    const iDef = ITEM_FIELDS[itemField];
    const human = readHumanValue(hDef, profile[hDef.key as string]);
    const rawHuman = toStringArray(profile[hDef.key as string]);
    const itemRead = readItemValue(iDef, item, material);
    let itemVal = itemRead.value;

    const base = {
      sub_dimension: subDimension, human_field: humanField, item_field: itemField,
      unit_weight: round(w, 3),
      human_value: rawHuman.length === 0 ? null : (rawHuman.length === 1 ? rawHuman[0] : rawHuman),
      item_value: itemRead.raw,
    };

    // 用户数据校验异常优先报告：跳过单元并记录，不让整个请求失败
    if (human.kind === "invalid") {
      const err = { ...base, status: "validation_error" as UnitStatus, reason: human.reason };
      units.push(err);
      unitValidationErrors.push(err);
      log("[matching] 用户数据校验异常，跳过计分单元:", err);
      continue;
    }

    let iConf: number | "rejected" | undefined;
    if (itemVal !== null) {
      iConf = await itemConf(itemField);
      if (iConf === "rejected") itemVal = null;
    }

    if (human.kind === "missing" || itemVal === null) {
      units.push({
        ...base, status: "not_applicable" as UnitStatus,
        reason: human.kind === "missing" ? "human_missing_or_uncertain" : (iConf === "rejected" ? "item_rejected" : "item_missing_or_uncertain"),
      });
      continue;
    }

    const conf = Math.min(await humanConf(humanField), iConf as number);
    const hits = unitRules.filter(r => ruleHits(r, human.values, itemVal!));

    if (hits.length > 1) {
      const err = { ...base, status: "validation_error" as UnitStatus, reason: "multiple_rules_hit", rule_ids: hits.map(h => h.ruleId) };
      units.push(err);
      unitValidationErrors.push(err);
      log("[matching] 计分单元命中多条规则:", err);
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

    ruleResults.push({
      rule_id: r.ruleId, dimension: channel, match_type: r.matchType, strength: r.strength,
      compatibility: c, rule_weight: round(w, 3), contribution: round(c * w, 3),
      reason_code: r.reasonCode, human_value: base.human_value, item_value: itemVal,
      confidence: conf, match_status: "explicit_rule", rule_version: r.ruleVersion,
    });
    units.push({ ...base, status: "explicit_rule" as UnitStatus, rule_id: r.ruleId, compatibility: c, contribution: round(c * w, 3), confidence: conf });
  }

  const score = applicableW > 0 ? round((scoreSum / applicableW) * 100, 2) : null;
  const dataCoverage = totalW > 0 ? round(applicableW / totalW, 3) : 0;
  const ruleCoverage = applicableW > 0 ? round(explicitW / applicableW, 3) : null;
  const confidence = applicableW > 0 ? round(confSum / applicableW, 3) : null;

  // ── 2. 硬约束 → 资格（不改变分数和覆盖率）──
  const eligibility: Eligibility = { purchase: true, recommendation: true, styling: true };
  const constraintResults: any[] = [];

  for (const r of constraintRules) {
    const hDef = HUMAN_FIELDS[r.humanField];
    const iDef = ITEM_FIELDS[r.itemField];
    const human = readHumanValue(hDef, profile[hDef.key as string]);
    const itemRead = readItemValue(iDef, item, material);
    let itemVal = itemRead.value;
    if (itemVal !== null && (await itemConf(r.itemField)) === "rejected") itemVal = null;

    const base = { rule_id: r.ruleId, constraint_scope: r.constraintScope, human_field: r.humanField, item_field: r.itemField, rule_version: r.ruleVersion };
    let status: ConstraintStatus;
    if (human.kind === "invalid") {
      status = "validation_error";
      log("[matching] 硬约束用户数据校验异常，未判定:", { ...base, reason: human.reason });
    } else if (human.kind === "missing" || itemVal === null) {
      // 证据不足时不关闭资格
      status = "not_evaluable";
    } else {
      status = ruleHits(r, human.values, itemVal) ? "triggered" : "clear";
    }
    constraintResults.push({ ...base, status, reason_code: r.reasonCode });

    if (status === "triggered") {
      const scope = r.constraintScope;
      if (scope === "purchase" || scope === "all") eligibility.purchase = false;
      if (scope === "recommendation" || scope === "all") eligibility.recommendation = false;
      if (scope === "styling" || scope === "all") eligibility.styling = false;
    }
  }

  const dimensionResult = {
    dimension: channel,
    score,
    score_band: scoreBand(score),
    data_coverage: dataCoverage,
    rule_coverage: ruleCoverage,
    confidence,
    eligibility,
    strengths: [...strengths],
    warnings: [...warnings],
    rules_applied: ruleResults.length,
    default_neutral_units: units.filter(u => u.status === "default_neutral").length,
    units_skipped: units.filter(u => u.status === "not_applicable" || u.status === "validation_error").length,
    constraints_triggered: constraintResults.filter(c => c.status === "triggered").length,
    // 本次实际参与判定的规则版本（如实列出，可能不止一个；未填版本的规则记为 null）
    rule_versions: [...new Set(rules.map(r => r.ruleVersion ?? null))].sort((a, b) => String(a).localeCompare(String(b))),
  };

  return {
    dimensionResult,
    // 未四舍五入的值，供汇总层做 0.30 门槛判断和权重计算（③C 第四节）
    exact: { data_coverage: totalW > 0 ? applicableW / totalW : 0 },
    detail: {
      rule_results: ruleResults,
      units,
      unit_validation_errors: unitValidationErrors,
      constraint_results: constraintResults,
      scoring_rules: scoringRules.length,
      constraint_rules: constraintRules.length,
    },
  };
}
