import { ENGINE_VERSION, scoreBand, round, Eligibility } from "./matching-core";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine V1.0 —— 七维汇总层（纯函数，不访问数据库）
// 对齐 ③C《Match Score & Explainability Spec V1.0》（2026-09-30）
//
//   输入：各维度的 Dimension Result（缺失维度传 null 或不传）+ 场景 + 用户优先级
//   输出：match_score / score_band / overall_status / dimension_coverage /
//         总层 data_coverage、rule_coverage、confidence / weights_used /
//         三项 eligibility / strengths / warnings / diagnostics / adjustments
//
// 内部权重一律用"整数百分点"计算，避免 0.1 + 0.2 这类浮点误差影响 50% 门槛判断。
// ══════════════════════════════════════════════════════════════════

export const DIMENSIONS = [
  "body_fit", "face_fit", "style_fit", "color_fit", "preference_fit", "scenario_fit", "budget_fit",
] as const;
export type Dimension = typeof DIMENSIONS[number];

// ③C 第二节：默认权重（百分点），合计 100
export const DEFAULT_WEIGHT_PCT: Record<Dimension, number> = {
  body_fit: 20, face_fit: 10, style_fit: 20, color_fit: 20,
  preference_fit: 15, scenario_fit: 10, budget_fit: 5,
};

// ③C 第二节：场景枚举与调权矩阵。矩阵批准前全部为 0
export const SCENARIOS = ["work", "social", "travel", "casual", "formal", "other"] as const;
export type Scenario = typeof SCENARIOS[number];
export const SCENARIO_MATRIX_VERSION = "none_v1.0";
const ZERO: Record<Dimension, number> = Object.fromEntries(DIMENSIONS.map(d => [d, 0])) as Record<Dimension, number>;
export const SCENARIO_ADJUSTMENT_PCT: Record<Scenario, Record<Dimension, number>> = {
  work: { ...ZERO }, social: { ...ZERO }, travel: { ...ZERO },
  casual: { ...ZERO }, formal: { ...ZERO }, other: { ...ZERO },
};

// ③C 第三节：用户优先级，一次最多一个维度，只加不减
export const PRIORITY_INCREMENT_PCT = { low: 1, medium: 3, high: 5 } as const;
export type PriorityLevel = keyof typeof PRIORITY_INCREMENT_PCT;
export type Priority = { dimension: Dimension; level: PriorityLevel };

// ③C 第四节：门槛
export const MIN_DIMENSION_DATA_COVERAGE = 0.3;
export const MIN_VALID_DIMENSIONS = 3;
export const MIN_DIMENSION_COVERAGE_PCT = 50;

// 各维度计分结果中，汇总层需要的字段
export interface DimensionInput {
  result_id?: string;
  score: number | null;
  data_coverage: number;
  rule_coverage: number | null;
  confidence: number | null;
  eligibility: Eligibility;
  strengths: string[];
  warnings: string[];
  unit_validation_error_count: number;
  engine_version: string;
  rule_versions: (string | null)[];
}

export type DimensionState = "valid" | "invalid" | "missing";

// ③C 第十一节：系统诊断码（不写入 matching_reason_codes）
export type SystemCode =
  | "INSUFFICIENT_COVERAGE" | "PURCHASE_INELIGIBLE" | "RECOMMENDATION_INELIGIBLE"
  | "STYLING_INELIGIBLE" | "UNIT_VALIDATION_ERROR";

export type Explanation =
  | { source: "rule"; code: string; dimension: Dimension }
  | { source: "system"; code: SystemCode; scope: "overall" | "dimension"; dimension?: Dimension; count?: number; display: "independent" | "warning" };

export interface AggregateInput {
  dimensions: Partial<Record<Dimension, DimensionInput | null>>;
  scenario?: Scenario | null;
  priority?: Priority | null;
  profile_version: number;
}

export function aggregate(input: AggregateInput) {
  const scenario = input.scenario ?? null;
  const priority = input.priority ?? null;

  const state = {} as Record<Dimension, DimensionState>;
  for (const d of DIMENSIONS) {
    const r = input.dimensions[d];
    if (!r) state[d] = "missing";
    else if (r.score !== null && Number.isFinite(r.score) && r.data_coverage >= MIN_DIMENSION_DATA_COVERAGE) state[d] = "valid";
    else state[d] = "invalid";
  }
  const valid = DIMENSIONS.filter(d => state[d] === "valid");

  // 门槛只看固定默认权重，不受场景和优先级影响（③C 第四节）
  const coveragePct = valid.reduce((s, d) => s + DEFAULT_WEIGHT_PCT[d], 0);
  const sufficient = valid.length >= MIN_VALID_DIMENSIONS && coveragePct >= MIN_DIMENSION_COVERAGE_PCT;

  // 实际贡献权重（③C 第三节）
  const rawPct = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) {
    rawPct[d] = DEFAULT_WEIGHT_PCT[d]
      + (scenario ? SCENARIO_ADJUSTMENT_PCT[scenario][d] : 0)
      + (priority && priority.dimension === d ? PRIORITY_INCREMENT_PCT[priority.level] : 0);
  }
  const contrib = {} as Record<Dimension, number>;
  let contribSum = 0;
  for (const d of DIMENSIONS) {
    contrib[d] = state[d] === "valid" ? rawPct[d] * input.dimensions[d]!.data_coverage : 0;
    contribSum += contrib[d];
  }
  const weightsUsed = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) weightsUsed[d] = contribSum > 0 ? contrib[d] / contribSum : 0;

  const matchScore = sufficient
    ? round(valid.reduce((s, d) => s + weightsUsed[d] * input.dimensions[d]!.score!, 0), 2)
    : null;

  // 总层指标（③C 第六节）
  let dataCov = 0, ruleNum = 0, ruleDen = 0;
  for (const d of DIMENSIONS) {
    const r = input.dimensions[d];
    if (!r) continue;
    const wd = (DEFAULT_WEIGHT_PCT[d] / 100) * r.data_coverage;
    dataCov += wd;
    if (r.rule_coverage !== null && wd > 0) { ruleNum += wd * r.rule_coverage; ruleDen += wd; }
  }
  let confNum = 0, confDen = 0;
  for (const d of valid) {
    const c = input.dimensions[d]!.confidence;
    if (c !== null) { confNum += weightsUsed[d] * c; confDen += weightsUsed[d]; }
  }

  // 资格：合并所有已计算维度（含 invalid），与覆盖率门槛无关（③C 第八节）
  const eligibility: Eligibility = { purchase: true, recommendation: true, styling: true };
  for (const d of DIMENSIONS) {
    const r = input.dimensions[d];
    if (!r) continue;
    eligibility.purchase &&= r.eligibility.purchase;
    eligibility.recommendation &&= r.eligibility.recommendation;
    eligibility.styling &&= r.eligibility.styling;
  }

  // 解释：规则原因码 + 系统诊断码，来源分开标记（③C 第十一节）
  const strengths: Explanation[] = [];
  const warnings: Explanation[] = [];
  const diagnostics: Explanation[] = [];
  if (!sufficient) diagnostics.push({ source: "system", code: "INSUFFICIENT_COVERAGE", scope: "overall", display: "independent" });
  if (!eligibility.purchase) diagnostics.push({ source: "system", code: "PURCHASE_INELIGIBLE", scope: "overall", display: "independent" });
  if (!eligibility.recommendation) diagnostics.push({ source: "system", code: "RECOMMENDATION_INELIGIBLE", scope: "overall", display: "independent" });
  if (!eligibility.styling) diagnostics.push({ source: "system", code: "STYLING_INELIGIBLE", scope: "overall", display: "independent" });

  // 同类内按维度默认权重从高到低（同权重按维度顺序）
  const byWeight = [...DIMENSIONS].sort((a, b) => DEFAULT_WEIGHT_PCT[b] - DEFAULT_WEIGHT_PCT[a]);
  for (const d of byWeight) {
    const r = input.dimensions[d];
    if (!r) continue;
    if (r.unit_validation_error_count > 0) {
      diagnostics.push({ source: "system", code: "UNIT_VALIDATION_ERROR", scope: "dimension", dimension: d, count: r.unit_validation_error_count, display: "warning" });
    }
    for (const c of r.strengths) strengths.push({ source: "rule", code: c, dimension: d });
    for (const c of r.warnings) warnings.push({ source: "rule", code: c, dimension: d });
  }

  const dimensions = {} as Record<Dimension, (DimensionInput & { state: DimensionState }) | null>;
  for (const d of DIMENSIONS) {
    const r = input.dimensions[d];
    dimensions[d] = r ? { ...r, state: state[d] } : null;
  }

  return {
    engine_version: ENGINE_VERSION,
    profile_version: input.profile_version,
    overall_status: sufficient ? "ok" as const : "insufficient_coverage" as const,
    match_score: matchScore,
    score_band: scoreBand(matchScore),
    dimension_coverage: coveragePct / 100,
    valid_dimensions: valid.length,
    data_coverage: round(dataCov, 3),
    rule_coverage: ruleDen > 0 ? round(ruleNum / ruleDen, 3) : null,
    confidence: confDen > 0 ? round(confNum / confDen, 3) : null,
    purchase_eligibility: eligibility.purchase,
    recommendation_eligibility: eligibility.recommendation,
    styling_eligibility: eligibility.styling,
    weights_used: Object.fromEntries(DIMENSIONS.map(d => [d, round(weightsUsed[d], 4)])) as Record<Dimension, number>,
    scenario,
    scenario_matrix_version: SCENARIO_MATRIX_VERSION,
    priority,
    dimensions,
    strengths,
    warnings,
    diagnostics,
    display: selectForDisplay(strengths, warnings, diagnostics),
    adjustments: [] as never[],
  };
}

// ③C 第十一节：前端最多 3 条 strengths + 2 条 warnings。
// 独立展示的诊断（覆盖不足、资格关闭）不占 warnings 名额；
// 其余按"校验异常 → 规则冲突"排序，同 code 去重。
export function selectForDisplay(strengths: Explanation[], warnings: Explanation[], diagnostics: Explanation[]) {
  const dedupe = (list: Explanation[]) => {
    const seen = new Set<string>();
    return list.filter(e => (seen.has(e.code) ? false : (seen.add(e.code), true)));
  };
  const inlineDiagnostics = diagnostics.filter(e => e.source === "system" && e.display === "warning");
  return {
    strengths: dedupe(strengths).slice(0, 3),
    warnings: dedupe([...inlineDiagnostics, ...warnings]).slice(0, 2),
    independent: diagnostics.filter(e => e.source === "system" && e.display === "independent").map(e => e.code),
  };
}

// ── 请求参数校验（③C 第三节：优先级一次最多一个维度）─────────────
export function parsePriority(raw: unknown): { ok: true; value: Priority | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: true, value: null };
    if (raw.length > 1) return { ok: false, error: "priority 一次最多指定一个维度" };
    raw = raw[0];
  }
  const p = raw as { dimension?: unknown; level?: unknown };
  if (typeof p !== "object" || !DIMENSIONS.includes(p.dimension as Dimension)) return { ok: false, error: "priority.dimension 不合法" };
  if (!(String(p.level) in PRIORITY_INCREMENT_PCT)) return { ok: false, error: "priority.level 只能是 low / medium / high" };
  return { ok: true, value: { dimension: p.dimension as Dimension, level: p.level as PriorityLevel } };
}
