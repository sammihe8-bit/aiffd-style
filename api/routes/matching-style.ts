import { STYLE_CODES } from "../../db/schema";
import { round, assertRange, scoreBand, itemSourceConfidence, Eligibility } from "./matching-core";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine —— Style Fit 专用计分（纯函数，不访问数据库，可单独测试）
// 对齐 03A Part C Style Fit（2026-10-03）
//
// 不使用 matching_rules 规则表。人侧 13 型概率作权重，对商品各型风格分求加权平均：
//   w_k = p_k ^ γ（γ 默认 1）；K = 商品有分数的型
//   score         = 100 × Σ_K w·s ÷ Σ_K w
//   data_coverage = Σ_K w ÷ Σ_全部13型 w
//   rule_coverage = 1（公式对每个已评估的型都有定义）
//   confidence    = Σ_K w·min(c人, c商品_k) ÷ Σ_K w
// 商品没打分的型不当 0，也不参与平均；人侧不足 13 型不计算，不用主/次型代码合成分布。
// 输出与 computeDimension 相同的 Dimension Result，七维汇总层不改。
// ══════════════════════════════════════════════════════════════════

export const STYLE_FIT_CHANNEL = "style_fit";
export const STYLE_FIT_RULE_VERSION = "v1.0";
export const STYLE_FIT_GAMMA = 1;
export const SUPPORTED_HUMAN_STYLE_ENGINES: readonly string[] = ["style_engine_v2.1"];

// 原因码阈值（03A Part C 第四节）
export const SF_THRESHOLDS = { echo: 0.6, weak: 0.3, foreign: 0.1 } as const;

// 4 个原因码，与 matching_reason_codes 中 channel = style_fit 的行一致
export const STYLE_FIT_REASONS = [
  { code: "SF_PRIMARY_ECHO", direction: "strength", meaning: "这件单品的风格和你的主风格一致" },
  { code: "SF_SECONDARY_ECHO", direction: "strength", meaning: "这件单品呼应了你风格中的另一面" },
  { code: "SF_PRIMARY_WEAK", direction: "warning", meaning: "这件单品和你的主风格不太一致" },
  { code: "SF_ITEM_STYLE_FOREIGN", direction: "warning", meaning: "这件单品的主风格在你身上较少体现" },
] as const;

const CODE_SET = new Set<string>(STYLE_CODES);

// decimal 列由驱动返回字符串，这里统一转成数字；空值返回 null，非法返回 NaN
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}
const inUnit = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

export interface HumanStyleRow {
  styleCode: string;
  probability: unknown;
  isPrimary: boolean;
  isSecondary: boolean;
  engineVersion: string | null;
}

export interface ItemStyleRow {
  styleCode: string;
  score: unknown;
  confidence: unknown;
  sourceMethod: string;
  verifiedStatus: string;
  isPrimary?: boolean;
}

export interface StyleFitInput {
  humanRows: HumanStyleRow[];
  itemRows: ItemStyleRow[];
  humanConfidence: number;              // 人侧来源置信度（取 primary_style 最新变更来源）
  reasonDir: Map<string, string>;       // reason_code → strength / warning
  gamma?: number;
}

type SkipReason = "human_scores_incomplete" | "item_scores_missing" | "item_scores_invalid" | "no_weight_on_scored_styles";

export function computeStyleFit(input: StyleFitInput) {
  const gamma = input.gamma ?? STYLE_FIT_GAMMA;
  const unitValidationErrors: { style_code: string | null; reason: string; side: "human" | "item" }[] = [];

  // ── 1. 人侧：必须 13 型齐全、不重复、每项 0~1 ──
  const p = new Map<string, number>();
  let humanOk = input.humanRows.length === STYLE_CODES.length;
  for (const r of input.humanRows) {
    const v = toNum(r.probability);
    if (!CODE_SET.has(r.styleCode) || p.has(r.styleCode) || !inUnit(v)) { humanOk = false; break; }
    p.set(r.styleCode, v);
  }
  if (p.size !== STYLE_CODES.length) humanOk = false;
  const primary = input.humanRows.find(r => r.isPrimary)?.styleCode ?? null;
  const secondary = input.humanRows.find(r => r.isSecondary)?.styleCode ?? null;
  const humanEngine = input.humanRows.find(r => r.engineVersion)?.engineVersion ?? null;

  // ── 2. 商品侧：rejected 行视为缺失；同型重复或数值非法 → 整维不计算 ──
  const s = new Map<string, { score: number; conf: number; row: ItemStyleRow }>();
  let itemRejected = 0;
  for (const r of input.itemRows) {
    if (r.verifiedStatus === "rejected") { itemRejected++; continue; }
    const v = toNum(r.score);
    const c = toNum(r.confidence);
    if (!CODE_SET.has(r.styleCode)) { unitValidationErrors.push({ style_code: String(r.styleCode), reason: "invalid_style_code", side: "item" }); continue; }
    if (s.has(r.styleCode)) { unitValidationErrors.push({ style_code: r.styleCode, reason: "duplicate_style_code", side: "item" }); continue; }
    if (!inUnit(v)) { unitValidationErrors.push({ style_code: r.styleCode, reason: "score_out_of_range", side: "item" }); continue; }
    if (c !== null && !inUnit(c)) { unitValidationErrors.push({ style_code: r.styleCode, reason: "confidence_out_of_range", side: "item" }); continue; }
    let conf: number;
    if (c !== null) conf = c;
    else {
      const sc = itemSourceConfidence(r.sourceMethod, r.verifiedStatus);
      conf = sc === "rejected" ? 0 : sc;   // rejected 已在上面跳过，这里只为类型完整
    }
    s.set(r.styleCode, { score: v, conf, row: r });
  }

  let skip: SkipReason | null = null;
  if (!humanOk) skip = "human_scores_incomplete";
  else if (unitValidationErrors.length > 0) skip = "item_scores_invalid";
  else if (s.size === 0) skip = "item_scores_missing";

  // ── 3. 计分 ──
  const units: { style_code: string; probability: number; weight: number; item_score: number; confidence: number; contribution: number }[] = [];
  let wAll = 0, wK = 0, wsK = 0, wcK = 0;
  if (!skip) {
    for (const code of STYLE_CODES) {
      const w = Math.pow(p.get(code)!, gamma);
      wAll += w;
      const it = s.get(code);
      if (!it) continue;
      const conf = Math.min(input.humanConfidence, it.conf);
      wK += w; wsK += w * it.score; wcK += w * conf;
      units.push({ style_code: code, probability: p.get(code)!, weight: round(w, 6), item_score: it.score, confidence: conf, contribution: round(w * it.score, 6) });
    }
    if (wK <= 0 || wAll <= 0) skip = "no_weight_on_scored_styles";
  }

  const computed = !skip;
  const score = computed ? round((wsK / wK) * 100, 2) : null;
  const exactDataCoverage = computed ? wK / wAll : 0;
  const dataCoverage = round(exactDataCoverage, 3);
  const ruleCoverage = computed ? 1 : null;
  const confidence = computed ? round(wcK / wK, 3) : null;

  // ── 4. 原因码（只输出 matching_reason_codes 里方向一致的码）──
  const strengths = new Set<string>();
  const warnings = new Set<string>();
  const emit = (code: string, dir: "strength" | "warning") => {
    if (input.reasonDir.get(code) !== dir) return;
    (dir === "strength" ? strengths : warnings).add(code);
  };
  if (computed) {
    const sPrimary = primary ? s.get(primary)?.score : undefined;
    const sSecondary = secondary ? s.get(secondary)?.score : undefined;
    if (sPrimary !== undefined && sPrimary >= SF_THRESHOLDS.echo) emit("SF_PRIMARY_ECHO", "strength");
    if (sSecondary !== undefined && sSecondary >= SF_THRESHOLDS.echo) emit("SF_SECONDARY_ECHO", "strength");
    if (sPrimary !== undefined && sPrimary <= SF_THRESHOLDS.weak) emit("SF_PRIMARY_WEAK", "warning");
    // 商品自身主型：取 is_primary 行；没有标记时取最高分（并列取 STYLE_CODES 顺序靠前的）
    const itemPrimary = [...s.values()].find(x => x.row.isPrimary)?.row.styleCode
      ?? [...s.entries()].sort((a, b) => b[1].score - a[1].score)[0]?.[0];
    if (itemPrimary !== undefined && p.get(itemPrimary)! <= SF_THRESHOLDS.foreign) emit("SF_ITEM_STYLE_FOREIGN", "warning");
  }

  // 输出前最后一道检查：出现 NaN / Infinity / 越界即抛错，路由层不会落库
  assertRange(`${STYLE_FIT_CHANNEL}.score`, score, 0, 100, true);
  assertRange(`${STYLE_FIT_CHANNEL}.data_coverage`, dataCoverage, 0, 1, false);
  assertRange(`${STYLE_FIT_CHANNEL}.data_coverage_exact`, exactDataCoverage, 0, 1, false);
  assertRange(`${STYLE_FIT_CHANNEL}.rule_coverage`, ruleCoverage, 0, 1, true);
  assertRange(`${STYLE_FIT_CHANNEL}.confidence`, confidence, 0, 1, true);

  const eligibility: Eligibility = { purchase: true, recommendation: true, styling: true };
  const unscored = computed ? STYLE_CODES.filter(c => !s.has(c)) : [];

  const dimensionResult = {
    dimension: STYLE_FIT_CHANNEL,
    score,
    score_band: scoreBand(score),
    data_coverage: dataCoverage,
    rule_coverage: ruleCoverage,
    confidence,
    eligibility,
    strengths: [...strengths],
    warnings: [...warnings],
    rules_applied: units.length,
    default_neutral_units: 0,
    units_skipped: unscored.length,
    constraints_triggered: 0,
    rule_versions: [STYLE_FIT_RULE_VERSION],
  };

  return {
    dimensionResult,
    exact: { data_coverage: exactDataCoverage },
    detail: {
      method: "weighted_style_affinity",
      gamma,
      skip_reason: skip,
      units,
      unscored_style_codes: unscored,
      human_primary_style: primary,
      human_secondary_style: secondary,
      human_engine_version: humanEngine,
      human_engine_supported: humanEngine !== null && SUPPORTED_HUMAN_STYLE_ENGINES.includes(humanEngine),
      human_rows: input.humanRows.length,
      item_rows: input.itemRows.length,
      item_rows_rejected: itemRejected,
      unit_validation_errors: unitValidationErrors,
      constraint_results: [] as unknown[],
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// 商品侧写入校验（POST /api/fashion-items/items/:itemId/style-scores 使用）
// 不要求 13 型齐全；同型不重复；每项 0~1；
// 主型最多 1 个且为所提交行中最高；次型最多 1 个、不与主型同一行、为其余最高、且必须有主型。
// 比较前按 2 位小数取整，与数据库 decimal(3,2) 一致。
// ══════════════════════════════════════════════════════════════════

export type ItemStyleScoreInput = {
  styleCode: string;
  score: number;
  isPrimary?: boolean;
  isSecondary?: boolean;
};

export const roundItemScore = (n: number) => Math.round(n * 100) / 100;

export function validateItemStyleScores(scores: ItemStyleScoreInput[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(scores) || scores.length === 0) return ["scores 至少要有 1 项"];

  const seen = new Set<string>();
  for (const x of scores) {
    if (!CODE_SET.has(x.styleCode)) problems.push(`非法风格代码: ${String(x.styleCode)}`);
    else if (seen.has(x.styleCode)) problems.push(`风格代码重复: ${x.styleCode}`);
    seen.add(x.styleCode);
    if (typeof x.score !== "number" || !Number.isFinite(x.score) || x.score < 0 || x.score > 1) {
      problems.push(`${String(x.styleCode)} 的 score 必须是 0~1 的有限数`);
    }
  }
  if (problems.length > 0) return problems;

  const primaries = scores.filter(x => x.isPrimary);
  const secondaries = scores.filter(x => x.isSecondary);
  if (primaries.length > 1) problems.push(`主型最多 1 个，实际 ${primaries.length} 个`);
  if (secondaries.length > 1) problems.push(`次型最多 1 个，实际 ${secondaries.length} 个`);
  if (problems.length > 0) return problems;

  const max = Math.max(...scores.map(x => roundItemScore(x.score)));
  const pri = primaries[0];
  const sec = secondaries[0];
  if (pri && roundItemScore(pri.score) < max) problems.push(`主型 ${pri.styleCode} 不是最高分`);
  if (sec) {
    if (!pri) problems.push("有次型时必须同时标记主型");
    else if (sec === pri) problems.push("次型不能与主型是同一项");
    else {
      const restMax = Math.max(...scores.filter(x => x !== pri).map(x => roundItemScore(x.score)));
      if (roundItemScore(sec.score) < restMax) problems.push(`次型 ${sec.styleCode} 不是其余最高分`);
    }
  }
  return problems;
}
