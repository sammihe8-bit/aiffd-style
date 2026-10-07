import { round, assertRange, scoreBand, itemSourceConfidence, Eligibility } from "./matching-core";
import { IMAGE_TAGS } from "../../db/schema";
import { parseStoredTags, canonicalOrder } from "./image-tags";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine —— Preference Fit 专用计分（纯函数，不访问数据库，可单独测试）
// 对齐 03A Part E Preference Fit V0.1 评审稿（2026-10-06）
//
// 两个单元（人侧 12 个风格形象标签 ↔ 商品级 fashion_item_image_tag_assessments）：
//   aspired  理想形象呼应  D = aspired_image_tags     qᴰ = max{s(t) : t ∈ Dᵥ}        基准权重 0.70
//   rejected 排斥避让      R = rejected_image_tags    qᴿ = 1 − max{s(t) : t ∈ Rᵥ}    基准权重 0.30
//   Dᵥ / Rᵥ = 集合中有合法、非 rejected 商品评估的标签；未评估 ≠ 0 分
//   cᴰ = |Dᵥ|÷|D|（D 为 NULL 时 0）；cᴿ = |Rᵥ|÷|R|（R 为 NULL 时 0；R = [] 时不适用）
//   gᴰ = 0.70·cᴰ，gᴿ = 0.30·cᴿ，G = gᴰ + gᴿ
//   score = 100 × (gᴰ·qᴰ + gᴿ·qᴿ) ÷ G（G = 0 时 null）
//   预期权重 B = 0.70 + Bᴿ（R = [] 时 Bᴿ = 0，否则 0.30）；data_coverage = G ÷ B
//   confidence：每个已评估相关标签取 min(人侧该题来源置信度, 商品该行置信度)，单元内等权平均，再按 gᴰ、gᴿ 加权
// "最喜欢"只用于解释，不改变分数；当前常穿与差异字段不参与计分。三项资格恒为 true。
// 权重、阈值均为 provisional（03A Part E 第十二节）；首阶段只开放 /score，不进入 /match。
// ══════════════════════════════════════════════════════════════════

export const PREFERENCE_FIT_CHANNEL = "preference_fit";
export const PREFERENCE_FIT_RULE_VERSION = "v0.1";
export const IMAGE_TAG_DICTIONARY_VERSION = "image_tags_v1";   // 12 个标签 id 冻结于 2026-10-05

export interface PreferenceFitParams {
  status: "provisional" | "confirmed";
  weights: { aspired: number; rejected: number };
  thresholds: { echo: number; conflict: number };
  paramStatus: Record<string, "confirmed" | "provisional">;
}

export const PREFERENCE_FIT_PARAMS: PreferenceFitParams = {
  status: "provisional",
  weights: { aspired: 0.7, rejected: 0.3 },
  thresholds: { echo: 0.75, conflict: 0.5 },
  paramStatus: {
    unit_weights: "provisional",
    reason_thresholds: "provisional",
    max_strategy: "provisional",
    empty_rejected_denominator: "provisional",
    avoidance_only_scoring: "provisional",
    confidence_aggregation: "provisional",
  },
};

// 原因码（03A Part E 第七节）。PF_FAVORITE_ECHO 与 PF_ASPIRED_ECHO 同时命中时，展示用 strengths 只保留 FAVORITE，
// 两者的触发依据都留在 detail.reason_basis
export const PREFERENCE_FIT_REASONS = [
  { code: "PF_ASPIRED_ECHO", direction: "strength", meaning: "这件单品呼应了你希望呈现的形象" },
  { code: "PF_FAVORITE_ECHO", direction: "strength", meaning: "这件单品呼应了你标记为最喜欢的形象" },
  { code: "PF_REJECTED_CONFLICT", direction: "warning", meaning: "这件单品包含你明确不喜欢的形象特征" },
] as const;

const TAG_SET = new Set<string>(IMAGE_TAGS);
const inUnit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

export function validatePreferenceFitParams(p: PreferenceFitParams): string[] {
  const problems: string[] = [];
  const { aspired, rejected } = p.weights;
  if (!(inUnit(aspired) && aspired > 0)) problems.push("aspired 权重必须在 (0,1]");
  if (!(inUnit(rejected) && rejected > 0)) problems.push("rejected 权重必须在 (0,1]");
  if (inUnit(aspired) && inUnit(rejected) && Math.abs(aspired + rejected - 1) > 1e-9) problems.push(`权重合计应为 1，实际 ${aspired + rejected}`);
  if (!inUnit(p.thresholds.echo)) problems.push("echo 阈值必须在 [0,1]");
  if (!inUnit(p.thresholds.conflict)) problems.push("conflict 阈值必须在 [0,1]");
  return problems;
}

// ── 输入 ─────────────────────────────────────────────────────────
export interface HumanTagEvidence {
  confidence: number;
  confidenceSource?: "change_log" | "no_record_fallback";
}
export interface ItemImageTagRow {
  tagId: unknown;
  variantId?: unknown;
  score: unknown;
  confidence?: unknown;
  sourceMethod: string;
  verifiedStatus: string;
}
export interface PreferenceFitInput {
  human: {
    aspiredImageTags: unknown;          // 库里原值（JSON 字符串或 NULL）
    aspiredImageTagFavorite: unknown;
    rejectedImageTags: unknown;
    aspiredConfidence: HumanTagEvidence;   // aspired_image_tags 最新变更来源
    rejectedConfidence: HumanTagEvidence;  // rejected_image_tags 最新变更来源
  };
  itemRows: ItemImageTagRow[];          // 该商品在 fashion_item_image_tag_assessments 的全部行
  reasonDir: Map<string, string>;
  params?: PreferenceFitParams;
}

type UnitName = "aspired" | "rejected";
type SkipReason = "input_invalid" | "no_relevant_assessments";

export interface TagEvidence {
  tag_id: string;
  item_score: number;
  item_confidence: number;
  item_confidence_source: "row" | "field_source";
  item_source_method: string;
  item_verified_status: string;
  confidence: number;               // min(人侧, 商品)
}

export interface PreferenceUnitDetail {
  unit: UnitName;
  base_weight: number;
  expected_weight: number;          // 计入 B 的权重（R = [] 时为 0）
  human_tags: string[] | null;      // 人侧集合（NULL = 未回答）
  status: "scored" | "not_applicable" | "unanswered" | "no_assessments" | "input_invalid";
  evaluated: TagEvidence[];
  unknown_tags: string[];           // 人侧相关、但商品没有有效评估的标签
  max_tags: string[];               // 取得最高商品分的标签（并列全部记录）
  unit_score: number | null;        // qᴰ / qᴿ
  coverage: number;                 // cᴰ / cᴿ
  contribution_weight: number;      // gᴰ / gᴿ
  human_confidence: number | null;
  human_confidence_source: "change_log" | "no_record_fallback" | null;
  confidence: number | null;        // 单元内等权平均
}

export function computePreferenceFit(input: PreferenceFitInput) {
  const params = input.params ?? PREFERENCE_FIT_PARAMS;
  const paramProblems = validatePreferenceFitParams(params);
  if (paramProblems.length > 0) throw new Error(`PREFERENCE_FIT_PARAMS_INVALID: ${paramProblems.join("；")}`);

  const validationErrors: { side: "human" | "item"; field: string; reason: string; value: string | null }[] = [];
  const asStr = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

  // ── 1. 人侧（读取端再校验一次历史数据：非法则整维不计算，不静默修正）──
  const parseHumanSet = (field: string, raw: unknown, min: number, max: number): string[] | null | "invalid" => {
    if (raw === null || raw === undefined || raw === "") return null;
    const arr = parseStoredTags(raw);
    if (arr === null) { validationErrors.push({ side: "human", field, reason: "not_a_tag_array", value: asStr(raw) }); return "invalid"; }
    const bad = arr.filter(t => !TAG_SET.has(t));
    if (bad.length > 0) { validationErrors.push({ side: "human", field, reason: "unknown_tag", value: JSON.stringify(bad) }); return "invalid"; }
    if (new Set(arr).size !== arr.length) { validationErrors.push({ side: "human", field, reason: "duplicate_tag", value: JSON.stringify(arr) }); return "invalid"; }
    if (arr.length < min || arr.length > max) { validationErrors.push({ side: "human", field, reason: "count_out_of_range", value: JSON.stringify(arr) }); return "invalid"; }
    return canonicalOrder(arr);
  };
  const D = parseHumanSet("aspired_image_tags", input.human.aspiredImageTags, 3, 5);
  const R = parseHumanSet("rejected_image_tags", input.human.rejectedImageTags, 0, IMAGE_TAGS.length);
  const favRaw = input.human.aspiredImageTagFavorite;
  const favorite = favRaw === null || favRaw === undefined || favRaw === "" ? null : String(favRaw);
  if (favorite !== null && (!TAG_SET.has(favorite) || !(Array.isArray(D) && D.includes(favorite)))) {
    validationErrors.push({ side: "human", field: "aspired_image_tag_favorite", reason: "not_in_aspired", value: favorite });
  }
  if (Array.isArray(D) && Array.isArray(R)) {
    const overlap = R.filter(t => D.includes(t));
    if (overlap.length > 0) validationErrors.push({ side: "human", field: "aspired_image_tags/rejected_image_tags", reason: "overlap", value: JSON.stringify(overlap) });
  }
  for (const [field, ev] of [["aspired_image_tags", input.human.aspiredConfidence], ["rejected_image_tags", input.human.rejectedConfidence]] as const) {
    if (!inUnit(ev.confidence)) validationErrors.push({ side: "human", field, reason: "confidence_out_of_range", value: String(ev.confidence) });
  }

  // ── 2. 商品侧：V1 只读商品级行（variant_id 为空）；同一标签多行、非法分值或置信度 → 整维不计算 ──
  const itemLevel = input.itemRows.filter(r => r.variantId === null || r.variantId === undefined || r.variantId === "");
  const variantRowsIgnored = input.itemRows.length - itemLevel.length;
  const byTag = new Map<string, TagEvidence>();
  const rejectedRows: string[] = [];
  const seen = new Set<string>();
  for (const r of itemLevel) {
    const tag = typeof r.tagId === "string" ? r.tagId : null;
    if (tag === null || !TAG_SET.has(tag)) { validationErrors.push({ side: "item", field: "tag_id", reason: "unknown_tag", value: asStr(r.tagId) }); continue; }
    if (seen.has(tag)) { validationErrors.push({ side: "item", field: "tag_id", reason: "duplicate_rows", value: tag }); continue; }
    seen.add(tag);
    const s = toNum(r.score);
    if (s === null || !inUnit(s)) { validationErrors.push({ side: "item", field: `score:${tag}`, reason: "score_out_of_range", value: asStr(r.score) }); continue; }
    if (r.verifiedStatus === "rejected") { rejectedRows.push(tag); continue; }   // 视为未评估
    const rowConf = toNum(r.confidence);
    let conf: number; let from: "row" | "field_source";
    if (rowConf !== null) {
      if (!inUnit(rowConf)) { validationErrors.push({ side: "item", field: `confidence:${tag}`, reason: "confidence_out_of_range", value: asStr(r.confidence) }); continue; }
      conf = rowConf; from = "row";
    } else {
      const c = itemSourceConfidence(r.sourceMethod, r.verifiedStatus);
      if (c === "rejected") { rejectedRows.push(tag); continue; }
      conf = c; from = "field_source";
    }
    byTag.set(tag, {
      tag_id: tag, item_score: s, item_confidence: conf, item_confidence_source: from,
      item_source_method: r.sourceMethod, item_verified_status: r.verifiedStatus, confidence: conf,
    });
  }

  const invalid = validationErrors.length > 0;

  // ── 3. 两个单元 ──
  const { aspired: bD, rejected: bR } = params.weights;
  const buildUnit = (unit: UnitName, set: string[] | null, base: number, human: HumanTagEvidence): PreferenceUnitDetail => {
    const notApplicable = unit === "rejected" && Array.isArray(set) && set.length === 0;
    const expected = notApplicable ? 0 : base;
    const empty: PreferenceUnitDetail = {
      unit, base_weight: base, expected_weight: expected, human_tags: set,
      status: set === null ? "unanswered" : notApplicable ? "not_applicable" : "no_assessments",
      evaluated: [], unknown_tags: set ?? [], max_tags: [], unit_score: null, coverage: 0,
      contribution_weight: 0, human_confidence: null, human_confidence_source: null, confidence: null,
    };
    if (invalid) return { ...empty, status: "input_invalid", unknown_tags: [], human_tags: null };
    if (set === null || notApplicable) return empty;
    const evaluated = set.filter(t => byTag.has(t)).map(t => {
      const e = byTag.get(t)!;
      return { ...e, confidence: Math.min(human.confidence, e.item_confidence) };
    });
    const unknown = set.filter(t => !byTag.has(t));
    if (evaluated.length === 0) return { ...empty, unknown_tags: unknown };
    const maxScore = Math.max(...evaluated.map(e => e.item_score));
    const coverage = evaluated.length / set.length;
    return {
      ...empty, status: "scored", evaluated, unknown_tags: unknown,
      max_tags: evaluated.filter(e => e.item_score === maxScore).map(e => e.tag_id),
      unit_score: unit === "aspired" ? maxScore : round(1 - maxScore, 6),
      coverage,
      contribution_weight: base * coverage,
      human_confidence: human.confidence, human_confidence_source: human.confidenceSource ?? null,
      confidence: round(evaluated.reduce((a, e) => a + e.confidence, 0) / evaluated.length, 6),
    };
  };
  const uD = buildUnit("aspired", invalid ? null : (D as string[] | null), bD, input.human.aspiredConfidence);
  const uR = buildUnit("rejected", invalid ? null : (R as string[] | null), bR, input.human.rejectedConfidence);
  // 输入不合法时两单元都不计算，预期权重仍按原定义报告（便于排查），但 G = 0、score = null
  const units = [uD, uR];

  const B = uD.expected_weight + uR.expected_weight;
  const G = uD.contribution_weight + uR.contribution_weight;
  const computed = !invalid && G > 0;
  const skip: SkipReason | null = invalid ? "input_invalid" : G > 0 ? null : "no_relevant_assessments";

  const score = computed
    ? round((units.reduce((a, u) => a + (u.unit_score === null ? 0 : u.contribution_weight * u.unit_score), 0) / G) * 100, 2)
    : null;
  const exactDataCoverage = computed && B > 0 ? round(G / B, 12) : 0;
  const dataCoverage = round(exactDataCoverage, 3);
  const ruleCoverage = computed ? 1 : null;
  const confidence = computed
    ? round(units.reduce((a, u) => a + (u.confidence === null ? 0 : u.contribution_weight * u.confidence), 0) / G, 3)
    : null;

  const evidenceScope = !computed ? null
    : uD.status === "scored" && uR.status === "scored" ? "aspiration_and_avoidance"
    : uD.status === "scored" ? "aspiration_only" : "avoidance_only";

  // ── 4. 原因码（阈值含边界；只用合法有效评估；数据缺口不作为负面偏好）──
  const basis: { code: string; triggered: boolean; tags: string[]; value: number | null; threshold: number }[] = [];
  if (computed) {
    const maxD = uD.status === "scored" ? Math.max(...uD.evaluated.map(e => e.item_score)) : null;
    basis.push({ code: "PF_ASPIRED_ECHO", triggered: maxD !== null && maxD >= params.thresholds.echo, tags: uD.max_tags, value: maxD, threshold: params.thresholds.echo });
    const fav = favorite !== null ? uD.evaluated.find(e => e.tag_id === favorite) : undefined;
    basis.push({ code: "PF_FAVORITE_ECHO", triggered: !!fav && fav.item_score >= params.thresholds.echo, tags: favorite ? [favorite] : [], value: fav ? fav.item_score : null, threshold: params.thresholds.echo });
    const maxR = uR.status === "scored" ? Math.max(...uR.evaluated.map(e => e.item_score)) : null;
    basis.push({ code: "PF_REJECTED_CONFLICT", triggered: maxR !== null && maxR >= params.thresholds.conflict, tags: uR.max_tags, value: maxR, threshold: params.thresholds.conflict });
  }
  const fires = (code: string, dir: string) => basis.some(b => b.code === code && b.triggered) && input.reasonDir.get(code) === dir;
  const strengths: string[] = [];
  if (fires("PF_FAVORITE_ECHO", "strength")) strengths.push("PF_FAVORITE_ECHO");
  else if (fires("PF_ASPIRED_ECHO", "strength")) strengths.push("PF_ASPIRED_ECHO");   // 展示优先最喜欢，抑制重复的理想呼应
  const warnings: string[] = fires("PF_REJECTED_CONFLICT", "warning") ? ["PF_REJECTED_CONFLICT"] : [];

  assertRange(`${PREFERENCE_FIT_CHANNEL}.score`, score, 0, 100, true);
  assertRange(`${PREFERENCE_FIT_CHANNEL}.data_coverage`, dataCoverage, 0, 1, false);
  assertRange(`${PREFERENCE_FIT_CHANNEL}.data_coverage_exact`, exactDataCoverage, 0, 1, false);
  assertRange(`${PREFERENCE_FIT_CHANNEL}.rule_coverage`, ruleCoverage, 0, 1, true);
  assertRange(`${PREFERENCE_FIT_CHANNEL}.confidence`, confidence, 0, 1, true);

  // 首版排斥冲突只影响分数与解释，三项资格恒为 true（03A Part E 第五、八节）
  const eligibility: Eligibility = { purchase: true, recommendation: true, styling: true };
  const scoredUnits = units.filter(u => u.status === "scored").length;

  const dimensionResult = {
    dimension: PREFERENCE_FIT_CHANNEL,
    score,
    score_band: scoreBand(score),
    data_coverage: dataCoverage,
    rule_coverage: ruleCoverage,
    confidence,
    eligibility,
    strengths,
    warnings,
    rules_applied: scoredUnits,
    default_neutral_units: 0,
    units_skipped: computed ? units.length - scoredUnits : units.length,
    constraints_triggered: 0,
    rule_versions: [PREFERENCE_FIT_RULE_VERSION],
  };

  return {
    dimensionResult,
    exact: { data_coverage: exactDataCoverage },
    detail: {
      method: "aspiration_max_avoidance_max",
      params_status: params.status,
      param_status: params.paramStatus,
      dictionary_version: IMAGE_TAG_DICTIONARY_VERSION,
      skip_reason: skip,
      evidence_scope: evidenceScope,
      expected_weight: round(B, 12),
      contribution_weight: round(G, 12),
      favorite,
      units: units.map(u => ({ ...u, contribution_weight: round(u.contribution_weight, 12) })),   // 只在输出时去掉浮点噪声；内部计算保持原值
      reason_basis: basis,
      item_assessment_scope: "item_level",
      item_rows_total: input.itemRows.length,
      variant_rows_ignored: variantRowsIgnored,
      item_rows_rejected: canonicalOrder(rejectedRows),
      human_confidence_fallback_units: units.filter(u => u.human_confidence_source === "no_record_fallback").map(u => u.unit),
      unit_validation_errors: validationErrors,
      constraint_results: [] as unknown[],
    },
  };
}
