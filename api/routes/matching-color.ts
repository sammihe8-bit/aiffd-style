import { round, assertRange, scoreBand, itemSourceConfidence, Eligibility } from "./matching-core";

// ══════════════════════════════════════════════════════════════════
// AIFFD Matching Engine —— Color Fit 专用计分（纯函数，不访问数据库，可单独测试）
// 对齐 03A Part D Color Fit V0.1 评审稿（2026-10-04）
//
// 三个计分单元，人侧 Human Profile DB ↔ 商品侧变体色彩表：
//   temperature  warm_cool    ↔ fashion_variant_color_attributes.color_temperature   权重 0.4
//   season       season_name  ↔ fashion_variant_color_identity.season_name          权重 0.4
//   element      element_name ↔ fashion_variant_color_identity.element_name         权重 0.2
//
//   score         = 100 × Σ_有效单元 w·s ÷ Σ_有效单元 w      （缺失单元不当 0，不参与平均）
//   data_coverage = Σ_有效单元 w ÷ Σ_全部单元 w
//   rule_coverage = 1（有可计算单元时，公式对其有定义）；全部缺失时为 null
//   confidence    = Σ_有效单元 w·min(c人, c商品) ÷ Σ_有效单元 w；全部缺失时为 null
// 输出与 computeDimension 相同的 Dimension Result，七维汇总层不改。
//
// 已确认：专用函数、40/40/20 权重、缺失单元归一化；
//   olive 处理（任一侧为 olive → 冷暖单元不可比较，按缺失处理）——确认的是处理规则，不代表 olive 的色彩关系已验证；
//   五行关系 V1 无方向（同行 1.0 / 相生 0.7 / 相克 0.3，AIFFD 内部色彩关系编码，属产品参数）；
//   具体方向只记录在 detail.element_relation 供后续研究，不改变分数；相克不代表对用户不利、不影响资格。（2026-10-06 产品确认）
// 待验证（provisional）：冷暖距离分值、季型相似度矩阵、原因码阈值。
// 这些参数集中在 COLOR_FIT_PARAMS，改参数不用改计分代码；validateColorFitParams 保证配置自洽。
//
// 派生字段一致性（03A Part D Q7，已确认）：两侧都检查 season_element、final_season_25 与基础字段是否一致，
// 不改原值，冲突时停用受影响的单元并在 detail.derived_conflicts 记录；冷暖不受影响；派生字段缺失不反推。
// ══════════════════════════════════════════════════════════════════

export const COLOR_FIT_CHANNEL = "color_fit";
export const COLOR_FIT_RULE_VERSION = "v0.1";

// 合法枚举：与 db/schema.ts 一致（tests/matching-color.test.ts 直接比对两侧 schema 定义）
export const WARM_COOL_VALUES = ["warm", "cool", "neutral_warm", "neutral_cool", "olive", "uncertain"] as const;
export const SEASON_VALUES = ["春", "夏", "长夏", "秋", "冬"] as const;
export const ELEMENT_VALUES = ["木", "火", "土", "金", "水"] as const;
export type Season = typeof SEASON_VALUES[number];
export type Element = typeof ELEMENT_VALUES[number];

export type ColorUnit = "temperature" | "season" | "element";
export const COLOR_UNITS: readonly ColorUnit[] = ["temperature", "season", "element"];

// 合法但不计分的取值 → 该单元按缺失处理，明细里写明原因（不能静默给 0 分）
//   uncertain：任一侧"不确定"
//   olive：人的"橄榄底调"（肤色底调）与商品的"橄榄色"（商品颜色）语义不同，不能直接比较（2026-10-06 产品确认）
const TEMPERATURE_MISSING_REASON: Record<string, string> = {
  uncertain: "uncertain",
  olive: "olive_semantics_unconfirmed",
};

export interface ColorFitParams {
  status: "provisional" | "confirmed";
  unitWeights: Record<ColorUnit, number>;
  temperatureAxis: Record<string, number>;          // 冷暖轴位置；未列出的合法值见 TEMPERATURE_MISSING_REASON
  temperatureDistanceScore: number[];               // 下标 = 轴上距离
  seasonSimilarity: Record<Season, Record<Season, number>>;
  elementScore: { same: number; generating: number; overcoming: number };
  // 无方向配对：A–B 与 B–A 视为同一组关系（AIFFD 匹配假设，未经用户反馈校准）
  elementGeneratingPairs: [Element, Element][];
  elementOvercomingPairs: [Element, Element][];
  thresholds: { tempMatch: number; tempClash: number; seasonClash: number };
  itemConfidenceFallback: number;                   // 商品侧既无行内置信度、也无来源记录时的兜底
  paramStatus: Record<string, "confirmed" | "provisional">;
}

// 季型相似度草案：同季 1.0；下列四组 0.5；其余 0.2。
// 依据只是前端测试文案，尚未对照 AIFFD 五季的冷暖 / 明度 / 饱和度 / 对比度定义，不能作为正式矩阵。
// 2026-10-06 产品评审：「夏–冬」相近缺乏依据（AIFFD 的夏是高明度高饱和，文案未说明高对比；冬未说明高饱和），
// 待五季明度 / 饱和度定义补齐后按属性重新推导；在此之前整张矩阵保持 provisional，数值暂不改动。
const S_SAME = 1.0, S_NEAR = 0.5, S_FAR = 0.2;
const SEASON_NEAR_DRAFT: [Season, Season][] = [["春", "夏"], ["春", "秋"], ["秋", "长夏"], ["夏", "冬"]];
function buildSeasonMatrix(): Record<Season, Record<Season, number>> {
  const m = {} as Record<Season, Record<Season, number>>;
  for (const a of SEASON_VALUES) {
    m[a] = {} as Record<Season, number>;
    for (const b of SEASON_VALUES) m[a][b] = a === b ? S_SAME : S_FAR;
  }
  for (const [a, b] of SEASON_NEAR_DRAFT) { m[a][b] = S_NEAR; m[b][a] = S_NEAR; }
  return m;
}

export const COLOR_FIT_PARAMS: ColorFitParams = {
  status: "provisional",
  unitWeights: { temperature: 0.4, season: 0.4, element: 0.2 },
  temperatureAxis: { cool: -2, neutral_cool: -1, neutral_warm: 1, warm: 2 },
  temperatureDistanceScore: [1.0, 0.8, 0.5, 0.25, 0],
  seasonSimilarity: buildSeasonMatrix(),
  elementScore: { same: 1.0, generating: 0.7, overcoming: 0.3 },
  // 相生：木生火、火生土、土生金、金生水、水生木
  elementGeneratingPairs: [["木", "火"], ["火", "土"], ["土", "金"], ["金", "水"], ["水", "木"]],
  // 相克：木克土、土克水、水克火、火克金、金克木
  elementOvercomingPairs: [["木", "土"], ["土", "水"], ["水", "火"], ["火", "金"], ["金", "木"]],
  thresholds: { tempMatch: 0.8, tempClash: 0.25, seasonClash: 0.2 },
  itemConfidenceFallback: 0.8,
  paramStatus: {
    unit_weights: "confirmed",
    missing_unit_normalization: "confirmed",
    temperature_axis: "provisional",
    olive_handling: "confirmed",
    season_similarity: "provisional",
    element_relation: "confirmed",
    reason_thresholds: "provisional",
    item_confidence_fallback: "provisional",
  },
};

// 原因码（V0.1 评审参数，文案以 03A Part D 第七节为准）。文案只描述差异，不表达"禁止选择"。
export const COLOR_FIT_REASONS = [
  { code: "CF_TEMP_MATCH", direction: "strength", meaning: "这件单品的冷暖倾向与你较协调" },
  { code: "CF_SEASON_MATCH", direction: "strength", meaning: "这件单品与你的季型一致" },
  { code: "CF_TEMP_CLASH", direction: "warning", meaning: "冷暖方向差异较明显，可通过搭配衔接" },
  { code: "CF_SEASON_CLASH", direction: "warning", meaning: "季型色彩方向差异较大，可调整搭配面积" },
] as const;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const inUnit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const pairKey = (a: string, b: string) => [a, b].sort().join("|");

// 五季对应的季型主气（与前端 SEASON_META、src/utils/colorProfile.ts 一致），用于派生字段一致性检查
export const SEASON_ELEMENT_MAP: Record<Season, Element> = { 春: "木", 夏: "火", 长夏: "土", 秋: "金", 冬: "水" };
const FINAL_SEASON_25 = /^(春|夏|长夏|秋|冬)(木|火|土|金|水)$/;

// ── 写入端：商品色彩身份的派生字段一致性校验（POST /api/fashion-item/color-identity 使用）──
// 读取端（Q7）发现冲突时停用受影响的单元；写入端直接拒绝，防止再出现「秋 → 土」这类数据。
// 校验对象是「库里现值 + 本次提交」合并后的完整状态。只校验，不自动补全、不改写任何字段。
//   season_element 有值：season_name 必须有值，且 season_element = SEASON_ELEMENT_MAP[season_name]
//   final_season_25 有值：必须能拆成「季名 + 五行」，season_name、element_name 都必须有值且与拆出的部分一致
export interface ColorIdentityFields {
  seasonName: string | null; seasonElement: string | null; elementName: string | null; finalSeason25: string | null;
}
export interface ColorIdentityProblem {
  field: "season_element" | "final_season_25";
  reason: "base_missing" | "mismatch" | "unparseable";
  actual: string;
  expected: string | null;
}
export function checkColorIdentityConsistency(f: ColorIdentityFields): ColorIdentityProblem[] {
  const problems: ColorIdentityProblem[] = [];
  const season = f.seasonName !== null && (SEASON_VALUES as readonly string[]).includes(f.seasonName) ? (f.seasonName as Season) : null;
  const element = f.elementName !== null && (ELEMENT_VALUES as readonly string[]).includes(f.elementName) ? f.elementName : null;
  if (f.seasonElement !== null) {
    if (season === null) problems.push({ field: "season_element", reason: "base_missing", actual: f.seasonElement, expected: null });
    else if (f.seasonElement !== SEASON_ELEMENT_MAP[season]) {
      problems.push({ field: "season_element", reason: "mismatch", actual: f.seasonElement, expected: SEASON_ELEMENT_MAP[season] });
    }
  }
  if (f.finalSeason25 !== null) {
    const expected = season !== null && element !== null ? `${season}${element}` : null;
    if (!FINAL_SEASON_25.test(f.finalSeason25)) problems.push({ field: "final_season_25", reason: "unparseable", actual: f.finalSeason25, expected });
    else if (expected === null) problems.push({ field: "final_season_25", reason: "base_missing", actual: f.finalSeason25, expected: null });
    else if (f.finalSeason25 !== expected) problems.push({ field: "final_season_25", reason: "mismatch", actual: f.finalSeason25, expected });
  }
  return problems;
}

// ── 五行关系方向：只用于解释与研究，V1 计分不区分方向 ──
export type ElementRelation = "same" | "generating" | "overcoming";
export type ElementDirection = "human_generates_item" | "item_generates_human" | "human_overcomes_item" | "item_overcomes_human";
export function describeElementRelation(
  human: Element, item: Element, p: ColorFitParams = COLOR_FIT_PARAMS,
): { relation: ElementRelation; direction: ElementDirection | null } {
  if (human === item) return { relation: "same", direction: null };
  for (const [a, b] of p.elementGeneratingPairs) {            // 配对按 [生者, 被生者] 书写
    if (a === human && b === item) return { relation: "generating", direction: "human_generates_item" };
    if (a === item && b === human) return { relation: "generating", direction: "item_generates_human" };
  }
  for (const [a, b] of p.elementOvercomingPairs) {            // 配对按 [克者, 被克者] 书写
    if (a === human && b === item) return { relation: "overcoming", direction: "human_overcomes_item" };
    if (a === item && b === human) return { relation: "overcoming", direction: "item_overcomes_human" };
  }
  throw new Error(`COLOR_FIT_ELEMENT_PAIR_UNMAPPED: ${human}/${item}`);
}

// ── 配置自洽校验：返回问题列表，空数组表示通过 ──
export function validateColorFitParams(p: ColorFitParams): string[] {
  const problems: string[] = [];

  // 权重：三个单元齐全、各自 (0,1]、合计 1
  let wSum = 0;
  for (const u of COLOR_UNITS) {
    const w = p.unitWeights[u];
    if (!(typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 1)) problems.push(`单元权重 ${u} 必须在 (0,1]`);
    else wSum += w;
  }
  if (!near(wSum, 1)) problems.push(`单元权重合计应为 1，实际 ${wSum}`);

  // 冷暖轴：每个合法枚举要么在轴上，要么有明确的缺失原因，不能两头都没有，也不能两头都有
  for (const v of WARM_COOL_VALUES) {
    const onAxis = Object.prototype.hasOwnProperty.call(p.temperatureAxis, v);
    const asMissing = Object.prototype.hasOwnProperty.call(TEMPERATURE_MISSING_REASON, v);
    if (onAxis === asMissing) problems.push(`冷暖值 ${v} 必须且只能在"轴上"或"按缺失处理"其中一处`);
  }
  for (const k of Object.keys(p.temperatureAxis)) {
    if (!(WARM_COOL_VALUES as readonly string[]).includes(k)) problems.push(`冷暖轴含非法值 ${k}`);
    if (!Number.isInteger(p.temperatureAxis[k])) problems.push(`冷暖轴位置 ${k} 必须是整数`);
  }
  const positions = Object.values(p.temperatureAxis).filter(Number.isInteger);
  const maxDist = positions.length ? Math.max(...positions) - Math.min(...positions) : 0;
  const t = p.temperatureDistanceScore;
  if (t.length !== maxDist + 1) problems.push(`冷暖距离分值应有 ${maxDist + 1} 项，实际 ${t.length}`);
  if (!t.every(inUnit)) problems.push("冷暖距离分值必须都在 [0,1]");
  if (t.length > 0 && !near(t[0], 1)) problems.push("冷暖距离 0 必须得 1.0");
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) problems.push("冷暖距离分值必须随距离不增");

  // 季型矩阵：25 格齐全、[0,1]、同季 1.0、对称
  for (const a of SEASON_VALUES) {
    for (const b of SEASON_VALUES) {
      const v = p.seasonSimilarity?.[a]?.[b];
      if (!inUnit(v)) { problems.push(`季型矩阵 ${a}/${b} 缺失或不在 [0,1]`); continue; }
      if (a === b && !near(v, 1)) problems.push(`季型矩阵 ${a}/${a} 必须为 1.0`);
      const w = p.seasonSimilarity?.[b]?.[a];
      if (inUnit(w) && !near(v, w)) problems.push(`季型矩阵不对称：${a}/${b}=${v}，${b}/${a}=${w}`);
    }
  }
  for (const a of Object.keys(p.seasonSimilarity ?? {})) {
    if (!(SEASON_VALUES as readonly string[]).includes(a)) problems.push(`季型矩阵含非法季型 ${a}`);
    else for (const b of Object.keys(p.seasonSimilarity[a as Season])) {
      if (!(SEASON_VALUES as readonly string[]).includes(b)) problems.push(`季型矩阵含非法季型 ${a}/${b}`);
    }
  }

  // 五行：分值在 [0,1] 且同元素为 1.0；10 组无方向配对各归类恰好一次
  const es = p.elementScore;
  if (![es.same, es.generating, es.overcoming].every(inUnit)) problems.push("五行分值必须都在 [0,1]");
  if (!near(es.same, 1)) problems.push("同元素必须得 1.0");
  const seen = new Map<string, string>();
  const addPairs = (pairs: [string, string][], kind: string) => {
    for (const [a, b] of pairs) {
      if (!(ELEMENT_VALUES as readonly string[]).includes(a) || !(ELEMENT_VALUES as readonly string[]).includes(b)) {
        problems.push(`五行${kind}配对含非法元素 ${a}/${b}`); continue;
      }
      if (a === b) { problems.push(`五行${kind}配对不能是同一元素 ${a}`); continue; }
      const k = pairKey(a, b);
      if (seen.has(k)) problems.push(`五行配对 ${a}/${b} 重复归类（${seen.get(k)}、${kind}）`);
      else seen.set(k, kind);
    }
  };
  addPairs(p.elementGeneratingPairs, "相生");
  addPairs(p.elementOvercomingPairs, "相克");
  for (let i = 0; i < ELEMENT_VALUES.length; i++) {
    for (let j = i + 1; j < ELEMENT_VALUES.length; j++) {
      if (!seen.has(pairKey(ELEMENT_VALUES[i], ELEMENT_VALUES[j]))) problems.push(`五行配对 ${ELEMENT_VALUES[i]}/${ELEMENT_VALUES[j]} 没有归类`);
    }
  }

  // 阈值与兜底置信度
  const th = p.thresholds;
  if (![th.tempMatch, th.tempClash, th.seasonClash].every(inUnit)) problems.push("原因码阈值必须都在 [0,1]");
  if (inUnit(th.tempMatch) && inUnit(th.tempClash) && th.tempClash >= th.tempMatch) problems.push("tempClash 必须小于 tempMatch");
  if (!inUnit(p.itemConfidenceFallback)) problems.push("商品侧兜底置信度必须在 [0,1]");
  return problems;
}

// ── 输入 ─────────────────────────────────────────────────────────
// 人侧：字段值 + 该字段最新变更来源换算出的置信度（路由层用 HUMAN_SOURCE_CONFIDENCE 算好）
export interface HumanColorEvidence {
  value: unknown;
  confidence: number;
  confidenceSource?: "change_log" | "no_record_fallback";   // 路由层标记：有变更来源记录 / 无记录按兜底
}
// 商品侧：字段值 + 行内置信度（只有 color_identity 有）+ fashion_item_field_sources 的来源记录（可空）
export interface ItemColorEvidence {
  value: unknown;
  rowConfidence?: unknown;
  source?: { sourceMethod: string; verifiedStatus: string; confidence?: unknown } | null;
}

// 变体是怎么确定的：explicit 请求里传了；auto_single 商品只有一个变体自动采用；
// ambiguous 多个变体且没传；none 商品没有变体
export type VariantResolution = "explicit" | "auto_single" | "ambiguous" | "none";

export interface ColorFitInput {
  variantResolution: VariantResolution;
  human: {
    warmCool: HumanColorEvidence; seasonName: HumanColorEvidence; elementName: HumanColorEvidence;
    seasonElement?: unknown;        // 派生字段，只做一致性检查，不计分
    finalSeason25?: unknown;
  };
  item: {
    attributesRows: number;         // 该变体在 fashion_variant_color_attributes 的行数（0 / 1；多于 1 行视为数据异常）
    identityRows: number;           // 该变体在 fashion_variant_color_identity 的行数
    colorTemperature: ItemColorEvidence;
    seasonName: ItemColorEvidence;
    elementName: ItemColorEvidence;
    seasonElement?: unknown;        // 派生字段，只做一致性检查，不计分
    finalSeason25?: unknown;
  };
  reasonDir: Map<string, string>;   // reason_code → strength / warning（来自 matching_reason_codes）
  params?: ColorFitParams;
}

type SkipReason = "variant_required" | "item_color_missing" | "no_scorable_units";

export interface ColorUnitDetail {
  unit: ColorUnit;
  weight: number;
  human_value: string | null;
  item_value: string | null;
  status: "scored" | "missing";
  missing_reason: string | null;
  unit_score: number | null;
  human_confidence: number | null;
  human_confidence_source: "change_log" | "no_record_fallback" | null;
  item_confidence: number | null;
  item_confidence_source: "row" | "field_source" | "fallback" | null;
  confidence: number | null;
  contribution: number | null;
  evidence_group: "color_attributes" | "color_identity";
}

const asStr = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

export function computeColorFit(input: ColorFitInput) {
  const params = input.params ?? COLOR_FIT_PARAMS;
  const paramProblems = validateColorFitParams(params);
  if (paramProblems.length > 0) throw new Error(`COLOR_FIT_PARAMS_INVALID: ${paramProblems.join("；")}`);

  const unitValidationErrors: { unit: ColorUnit; side: "human" | "item"; reason: string; value: string | null }[] = [];
  const units: ColorUnitDetail[] = [];

  // 商品侧置信度：rejected → 证据作废（单元缺失）；行内置信度 → 来源记录 → 兜底
  const itemConf = (unit: ColorUnit, ev: ItemColorEvidence):
    { ok: true; conf: number; from: "row" | "field_source" | "fallback" } | { ok: false; reason: string } => {
    if (ev.source?.verifiedStatus === "rejected") return { ok: false, reason: "item_evidence_rejected" };
    const row = toNum(ev.rowConfidence);
    if (row !== null) {
      if (!inUnit(row)) {
        unitValidationErrors.push({ unit, side: "item", reason: "confidence_out_of_range", value: asStr(ev.rowConfidence) });
        return { ok: false, reason: "item_confidence_invalid" };
      }
      return { ok: true, conf: row, from: "row" };
    }
    if (ev.source) {
      const sc = toNum(ev.source.confidence);
      if (sc !== null) {
        if (!inUnit(sc)) {
          unitValidationErrors.push({ unit, side: "item", reason: "confidence_out_of_range", value: asStr(ev.source.confidence) });
          return { ok: false, reason: "item_confidence_invalid" };
        }
        return { ok: true, conf: sc, from: "field_source" };
      }
      const c = itemSourceConfidence(ev.source.sourceMethod, ev.source.verifiedStatus);
      if (c === "rejected") return { ok: false, reason: "item_evidence_rejected" };
      return { ok: true, conf: c, from: "field_source" };
    }
    return { ok: true, conf: params.itemConfidenceFallback, from: "fallback" };
  };

  const pushUnit = (
    unit: ColorUnit, group: ColorUnitDetail["evidence_group"],
    h: HumanColorEvidence, i: ItemColorEvidence,
    legal: readonly string[],
    missingReasonOf: (v: string) => string | null,
    scoreOf: (hv: string, iv: string) => number,
  ) => {
    const w = params.unitWeights[unit];
    const hv = asStr(h.value);
    const iv = asStr(i.value);
    const base: ColorUnitDetail = {
      unit, weight: w, human_value: hv, item_value: iv, status: "missing", missing_reason: null,
      unit_score: null, human_confidence: null, human_confidence_source: null,
      item_confidence: null, item_confidence_source: null,
      confidence: null, contribution: null, evidence_group: group,
    };
    const miss = (reason: string) => { units.push({ ...base, missing_reason: reason }); };

    if (hv === null) return miss("human_value_missing");
    if (!legal.includes(hv)) {
      unitValidationErrors.push({ unit, side: "human", reason: "invalid_value", value: hv });
      return miss("human_value_invalid");
    }
    if (iv === null) {
      const state = group === "color_attributes" ? attrState : identState;
      return miss(state === "duplicate" ? "item_rows_duplicate" : "item_value_missing");
    }
    if (!legal.includes(iv)) {
      unitValidationErrors.push({ unit, side: "item", reason: "invalid_value", value: iv });
      return miss("item_value_invalid");
    }
    const hd = disabled.human.has(unit), id = disabled.item.has(unit);
    if (hd) return miss("human_derived_conflict");
    if (id) return miss("item_derived_conflict");
    const hr = missingReasonOf(hv);
    if (hr) return miss(`human_${hr}`);
    const ir = missingReasonOf(iv);
    if (ir) return miss(`item_${ir}`);

    if (!inUnit(h.confidence)) {
      unitValidationErrors.push({ unit, side: "human", reason: "confidence_out_of_range", value: asStr(h.confidence) });
      return miss("human_confidence_invalid");
    }
    const ic = itemConf(unit, i);
    if (!ic.ok) return miss(ic.reason);

    const s = scoreOf(hv, iv);
    const conf = Math.min(h.confidence, ic.conf);
    units.push({
      ...base, status: "scored", unit_score: s,
      human_confidence: h.confidence, human_confidence_source: h.confidenceSource ?? null,
      item_confidence: ic.conf, item_confidence_source: ic.from,
      confidence: conf, contribution: round(w * s, 6),
    });
  };

  // ── 0. 派生字段一致性（Q7）：两侧分别检查，冲突只停用受影响的单元，不改原值、不反推缺失值 ──
  const derivedConflicts: {
    side: "human" | "item"; field: "season_element" | "final_season_25";
    actual: string; expected: string | null; disabled_units: ColorUnit[];
  }[] = [];
  const disabled = { human: new Set<ColorUnit>(), item: new Set<ColorUnit>() };
  const checkDerived = (side: "human" | "item", seasonRaw: unknown, elementRaw: unknown, seRaw: unknown, f25Raw: unknown) => {
    const season = asStr(seasonRaw), element = asStr(elementRaw);
    const seasonOk = season !== null && (SEASON_VALUES as readonly string[]).includes(season);
    const elementOk = element !== null && (ELEMENT_VALUES as readonly string[]).includes(element);
    const se = asStr(seRaw);
    if (se !== null && seasonOk) {
      const expected = SEASON_ELEMENT_MAP[season as Season];
      if (se !== expected) {
        derivedConflicts.push({ side, field: "season_element", actual: se, expected, disabled_units: ["season"] });
        disabled[side].add("season");
      }
    }
    const f25 = asStr(f25Raw);
    if (f25 !== null && (seasonOk || elementOk)) {
      const expected = seasonOk && elementOk ? `${season}${element}` : null;
      const m = FINAL_SEASON_25.exec(f25);
      const hit: ColorUnit[] = [];
      if (!m) {
        // 无法拆解定位：季型、副气都停用（冷暖不受影响）
        if (seasonOk) hit.push("season");
        if (elementOk) hit.push("element");
      } else {
        if (seasonOk && m[1] !== season) hit.push("season");
        if (elementOk && m[2] !== element) hit.push("element");
      }
      if (hit.length > 0) {
        derivedConflicts.push({ side, field: "final_season_25", actual: f25, expected, disabled_units: hit });
        for (const u of hit) disabled[side].add(u);
      }
    }
  };
  checkDerived("human", input.human.seasonName.value, input.human.elementName.value, input.human.seasonElement, input.human.finalSeason25);

  // 商品行数：0 行 = 没有该组数据；多于 1 行 = 数据异常，该组不使用（不挑其中一行）
  const groupState = (n: number) => (n === 0 ? "none" : n === 1 ? "single" : "duplicate");
  const attrState = groupState(input.item.attributesRows);
  const identState = groupState(input.item.identityRows);
  if (identState === "single") {
    checkDerived("item", input.item.seasonName.value, input.item.elementName.value, input.item.seasonElement, input.item.finalSeason25);
  }

  // ── 1. 变体与商品行 ──
  let skip: SkipReason | null = null;
  if (input.variantResolution === "ambiguous") skip = "variant_required";
  else if (input.variantResolution === "none") skip = "item_color_missing";
  else if (attrState === "none" && identState === "none") skip = "item_color_missing";

  // ── 2. 逐单元计分 ──
  const generating = new Set(params.elementGeneratingPairs.map(([a, b]) => pairKey(a, b)));
  const overcoming = new Set(params.elementOvercomingPairs.map(([a, b]) => pairKey(a, b)));
  if (!skip) {
    const noRow: ItemColorEvidence = { value: null };
    if (attrState === "duplicate") unitValidationErrors.push({ unit: "temperature", side: "item", reason: "duplicate_rows", value: String(input.item.attributesRows) });
    if (identState === "duplicate") unitValidationErrors.push({ unit: "season", side: "item", reason: "duplicate_rows", value: String(input.item.identityRows) });
    pushUnit("temperature", "color_attributes", input.human.warmCool,
      attrState === "single" ? input.item.colorTemperature : noRow,
      WARM_COOL_VALUES, v => TEMPERATURE_MISSING_REASON[v] ?? null,
      (hv, iv) => {
        const d = Math.abs(params.temperatureAxis[hv] - params.temperatureAxis[iv]);
        return params.temperatureDistanceScore[d];
      });
    pushUnit("season", "color_identity", input.human.seasonName,
      identState === "single" ? input.item.seasonName : noRow,
      SEASON_VALUES, () => null,
      (hv, iv) => params.seasonSimilarity[hv as Season][iv as Season]);
    pushUnit("element", "color_identity", input.human.elementName,
      identState === "single" ? input.item.elementName : noRow,
      ELEMENT_VALUES, () => null,
      (hv, iv) => {
        if (hv === iv) return params.elementScore.same;
        const k = pairKey(hv, iv);
        if (generating.has(k)) return params.elementScore.generating;
        if (overcoming.has(k)) return params.elementScore.overcoming;
        // validateColorFitParams 已保证 10 组配对齐全，走到这里说明配置被绕过
        throw new Error(`COLOR_FIT_ELEMENT_PAIR_UNMAPPED: ${hv}/${iv}`);
      });
  }

  // ── 3. 汇总 ──
  const scored = units.filter(u => u.status === "scored");
  const elementUnit = scored.find(u => u.unit === "element");
  const elementRelationDetail = elementUnit
    ? { ...describeElementRelation(elementUnit.human_value as Element, elementUnit.item_value as Element, params), scored_with_direction: false }
    : null;
  const wAll = COLOR_UNITS.reduce((a, u) => a + params.unitWeights[u], 0);
  const wV = scored.reduce((a, u) => a + u.weight, 0);
  if (!skip && scored.length === 0) skip = "no_scorable_units";

  const computed = !skip;
  const score = computed ? round((scored.reduce((a, u) => a + u.weight * u.unit_score!, 0) / wV) * 100, 2) : null;
  // 原始覆盖率（汇总门槛用它）；只清理浮点噪声（0.4 + 0.2 = 0.6000000000000001），不是业务取整
  const exactDataCoverage = computed ? round(wV / wAll, 12) : 0;
  const dataCoverage = round(exactDataCoverage, 3);
  const ruleCoverage = computed ? 1 : null;
  const confidence = computed ? round(scored.reduce((a, u) => a + u.weight * u.confidence!, 0) / wV, 3) : null;

  // ── 4. 原因码（只输出 matching_reason_codes 里方向一致的码）──
  const strengths = new Set<string>();
  const warnings = new Set<string>();
  const emit = (code: string, dir: "strength" | "warning") => {
    if (input.reasonDir.get(code) !== dir) return;
    (dir === "strength" ? strengths : warnings).add(code);
  };
  if (computed) {
    const t = scored.find(u => u.unit === "temperature");
    const s = scored.find(u => u.unit === "season");
    if (t && t.unit_score! >= params.thresholds.tempMatch) emit("CF_TEMP_MATCH", "strength");
    if (t && t.unit_score! <= params.thresholds.tempClash) emit("CF_TEMP_CLASH", "warning");
    if (s && s.human_value === s.item_value) emit("CF_SEASON_MATCH", "strength");
    if (s && s.unit_score! <= params.thresholds.seasonClash) emit("CF_SEASON_CLASH", "warning");
  }

  assertRange(`${COLOR_FIT_CHANNEL}.score`, score, 0, 100, true);
  assertRange(`${COLOR_FIT_CHANNEL}.data_coverage`, dataCoverage, 0, 1, false);
  assertRange(`${COLOR_FIT_CHANNEL}.data_coverage_exact`, exactDataCoverage, 0, 1, false);
  assertRange(`${COLOR_FIT_CHANNEL}.rule_coverage`, ruleCoverage, 0, 1, true);
  assertRange(`${COLOR_FIT_CHANNEL}.confidence`, confidence, 0, 1, true);

  // Color Fit 不产生资格限制：三项资格恒为 true（原因码只做解释，不表达禁止）
  const eligibility: Eligibility = { purchase: true, recommendation: true, styling: true };

  const dimensionResult = {
    dimension: COLOR_FIT_CHANNEL,
    score,
    score_band: scoreBand(score),
    data_coverage: dataCoverage,
    rule_coverage: ruleCoverage,
    confidence,
    eligibility,
    strengths: [...strengths],
    warnings: [...warnings],
    rules_applied: scored.length,
    default_neutral_units: 0,
    units_skipped: units.length - scored.length,
    constraints_triggered: 0,
    rule_versions: [COLOR_FIT_RULE_VERSION],
  };

  return {
    dimensionResult,
    exact: { data_coverage: exactDataCoverage },
    detail: {
      method: "weighted_color_units",
      params_status: params.status,
      param_status: params.paramStatus,
      skip_reason: skip,
      variant_resolution: input.variantResolution,
      units,
      item_confidence_fallback_units: units.filter(u => u.item_confidence_source === "fallback").map(u => u.unit),
      human_confidence_fallback_units: units.filter(u => u.human_confidence_source === "no_record_fallback").map(u => u.unit),
      derived_conflicts: derivedConflicts,
      // 副气单元计分时记录五行关系与方向；scored_with_direction 恒为 false（V1 不用方向改变分数）
      element_relation: elementRelationDetail,
      // 季型与副气都来自同一行 color_identity，是同一来源的证据，不代表两次独立验证
      shared_evidence_note: "season 与 element 共用 fashion_variant_color_identity 同一行，属同一来源证据",
      unit_validation_errors: unitValidationErrors,
      constraint_results: [] as unknown[],
    },
  };
}
