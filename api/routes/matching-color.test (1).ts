// 运行：npm run test:matching（或 npx tsx tests/matching-color.test.ts）
// 离线测试 matching-color.ts，不连数据库。覆盖 03A Part D Color Fit V0.1：枚举与 schema 一致、
// 配置自洽校验、三个单元的全组合穷举、缺失归一化、覆盖率与置信度、原因码、变体与缺失处理、汇总层接入。
// 测试数据取自 2026-10-04 线上查询：AIFFD_PROFILE_000001（版本 13）× AIFFD_VARIANT_000001（ITEM_000002）。
//   人侧：warm / 夏 / 火 / 木 / 夏木，三个计分字段最新来源都是 color_test（0.80）
//   商品：color_temperature neutral_warm，来源 manual_operator、confidence 0.85、unverified；
//         color_identity 秋 / 金（10-04 已由"土"修正）/ 木 / 秋木，行内 confidence 0.80，季型与副气无来源记录
// 注意：60.00 是草案矩阵下的预演值，不是正式 Color Fit 基准。
import assert from "node:assert/strict";
import {
  computeColorFit, validateColorFitParams, COLOR_FIT_PARAMS, COLOR_FIT_REASONS, ColorFitParams, ColorFitInput,
  WARM_COOL_VALUES, SEASON_VALUES, ELEMENT_VALUES, Season, checkColorIdentityConsistency,
} from "../api/routes/matching-color";
import { aggregate, DimensionInput, MIN_DIMENSION_DATA_COVERAGE } from "../api/routes/matching-aggregate";
import { humanStyleProfiles, fashionVariantColorAttributes, fashionVariantColorIdentity } from "../db/schema";

// 前端 SEASON_META 的五季主气，独立写一份用于核对（不引用被测代码里的映射）
const COLOR_SEASON_MAIN: Record<string, string> = { 春: "木", 夏: "火", 长夏: "土", 秋: "金", 冬: "水" };

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const allReasons = () => new Map<string, string>(COLOR_FIT_REASONS.map(r => [r.code, r.direction]));
const clone = (): ColorFitParams => JSON.parse(JSON.stringify(COLOR_FIT_PARAMS));

type Over = {
  human?: Partial<Record<"warmCool" | "seasonName" | "elementName", { value?: unknown; confidence?: number; confidenceSource?: "change_log" | "no_record_fallback" }>>;
  humanDerived?: { seasonElement?: unknown; finalSeason25?: unknown };
  item?: Partial<ColorFitInput["item"]>;
  variantResolution?: ColorFitInput["variantResolution"];
  reasonDir?: Map<string, string>;
  params?: ColorFitParams;
};
// 基准取真实数据（见文件头）。改了某一侧季型 / 副气的用例，该侧派生字段默认置空，避免与基准派生值冲突；
// 需要检查派生冲突的用例显式传入派生字段。
const run = (o: Over = {}) => {
  const humanBaseDerived = !o.human?.seasonName && !o.human?.elementName;
  const itemBaseDerived = !o.item?.seasonName && !o.item?.elementName;
  return computeColorFit({
    variantResolution: o.variantResolution ?? "auto_single",
    human: {
      warmCool: { value: "warm", confidence: 0.8, confidenceSource: "change_log", ...o.human?.warmCool },
      seasonName: { value: "夏", confidence: 0.8, confidenceSource: "change_log", ...o.human?.seasonName },
      elementName: { value: "木", confidence: 0.8, confidenceSource: "change_log", ...o.human?.elementName },
      seasonElement: humanBaseDerived ? "火" : null,
      finalSeason25: humanBaseDerived ? "夏木" : null,
      ...o.humanDerived,
    },
    item: {
      attributesRows: 1,
      identityRows: 1,
      colorTemperature: { value: "neutral_warm", source: { sourceMethod: "manual_operator", verifiedStatus: "unverified", confidence: "0.85" } },
      seasonName: { value: "秋", rowConfidence: "0.80" },
      elementName: { value: "木", rowConfidence: "0.80" },
      seasonElement: itemBaseDerived ? "金" : null,
      finalSeason25: itemBaseDerived ? "秋木" : null,
      ...o.item,
    },
    reasonDir: o.reasonDir ?? allReasons(),
    params: o.params,
  });
};
const unit = (r: ReturnType<typeof run>, u: string) => r.detail.units.find(x => x.unit === u)!;
const toInput = (r: ReturnType<typeof run>): DimensionInput => ({
  score: r.dimensionResult.score, data_coverage: r.exact.data_coverage, rule_coverage: r.dimensionResult.rule_coverage,
  confidence: r.dimensionResult.confidence, eligibility: r.dimensionResult.eligibility,
  strengths: r.dimensionResult.strengths, warnings: r.dimensionResult.warnings,
  unit_validation_error_count: r.detail.unit_validation_errors.length, engine_version: "matching_v1.0",
  rule_versions: r.dimensionResult.rule_versions,
});

// ── 枚举与 schema 一致（两侧都核对，避免遗漏 neutral 之类的合法值）──────────
test("枚举：冷暖 / 季型 / 五行与 schema.ts 人侧、商品侧定义完全一致", () => {
  assert.deepEqual([...humanStyleProfiles.warmCool.enumValues], [...WARM_COOL_VALUES]);
  assert.deepEqual([...fashionVariantColorAttributes.colorTemperature.enumValues], [...WARM_COOL_VALUES]);
  assert.deepEqual([...humanStyleProfiles.seasonName.enumValues], [...SEASON_VALUES]);
  assert.deepEqual([...fashionVariantColorIdentity.seasonName.enumValues], [...SEASON_VALUES]);
  assert.deepEqual([...humanStyleProfiles.elementName.enumValues], [...ELEMENT_VALUES]);
  assert.deepEqual([...fashionVariantColorIdentity.elementName.enumValues], [...ELEMENT_VALUES]);
  assert.ok(!(WARM_COOL_VALUES as readonly string[]).includes("neutral"), "两侧都没有单独的 neutral");
});

// ── 配置 ──────────────────────────────────────────────────────────
test("默认配置通过自洽校验，整体标记 provisional；已确认项：权重、归一化、olive 处理、五行无方向关系", () => {
  assert.deepEqual(validateColorFitParams(COLOR_FIT_PARAMS), []);
  assert.equal(COLOR_FIT_PARAMS.status, "provisional");
  const confirmed = Object.entries(COLOR_FIT_PARAMS.paramStatus).filter(([, s]) => s === "confirmed").map(([k]) => k);
  assert.deepEqual(confirmed.sort(), ["element_relation", "missing_unit_normalization", "olive_handling", "unit_weights"]);
  assert.equal(COLOR_FIT_PARAMS.paramStatus.season_similarity, "provisional", "季型矩阵在五季属性补齐前保持 provisional");
});

test("配置校验：季型矩阵缺格 / 不对称 / 同季不为 1 / 越界都能发现", () => {
  const has = (p: ColorFitParams, part: string) =>
    assert.ok(validateColorFitParams(p).some(x => x.includes(part)), `应报 ${part}：${validateColorFitParams(p).join("；")}`);
  let p = clone(); delete (p.seasonSimilarity["春"] as Record<string, number>)["冬"]; has(p, "春/冬 缺失");
  p = clone(); p.seasonSimilarity["春"]["夏"] = 0.6; has(p, "不对称");
  p = clone(); p.seasonSimilarity["秋"]["秋"] = 0.9; has(p, "秋/秋 必须为 1.0");
  p = clone(); p.seasonSimilarity["春"]["冬"] = 1.2; p.seasonSimilarity["冬"]["春"] = 1.2; has(p, "不在 [0,1]");
});

test("配置校验：权重、冷暖轴、距离分值、五行配对、阈值", () => {
  const has = (p: ColorFitParams, part: string) =>
    assert.ok(validateColorFitParams(p).some(x => x.includes(part)), `应报 ${part}：${validateColorFitParams(p).join("；")}`);
  let p = clone(); p.unitWeights.element = 0.3; has(p, "合计应为 1");
  p = clone(); delete p.temperatureAxis.neutral_cool; has(p, "neutral_cool");
  p = clone(); p.temperatureAxis.olive = 0; has(p, "olive");
  p = clone(); p.temperatureDistanceScore = [1, 0.8, 0.5, 0.25]; has(p, "应有 5 项");
  p = clone(); p.temperatureDistanceScore = [1, 0.5, 0.8, 0.25, 0]; has(p, "不增");
  p = clone(); p.elementOvercomingPairs.pop(); has(p, "没有归类");
  p = clone(); p.elementOvercomingPairs[0] = ["火", "木"]; has(p, "重复归类");
  p = clone(); p.thresholds.tempClash = 0.9; has(p, "tempClash 必须小于 tempMatch");
  p = clone(); p.unitWeights.element = 0.3;
  assert.throws(() => run({ params: p }), /COLOR_FIT_PARAMS_INVALID/);
});

// ── 计分基准（草案矩阵下的预演）─────────────────────────────────────
test("测试账号 × ITEM_000002：60.00 / 1.000 / 1 / 0.800（预演值）", () => {
  const r = run();
  assert.equal(r.dimensionResult.score, 60);
  assert.equal(r.dimensionResult.data_coverage, 1);
  assert.equal(r.dimensionResult.rule_coverage, 1);
  assert.equal(r.dimensionResult.confidence, 0.8);
  assert.equal(unit(r, "temperature").unit_score, 0.8);
  assert.equal(unit(r, "season").unit_score, 0.2);
  assert.equal(unit(r, "element").unit_score, 1);
  assert.deepEqual(r.dimensionResult.strengths, ["CF_TEMP_MATCH"]);
  assert.deepEqual(r.dimensionResult.warnings, ["CF_SEASON_CLASH"]);
  assert.equal(r.detail.params_status, "provisional");
  assert.equal(r.detail.skip_reason, null);
  assert.deepEqual(r.detail.unit_validation_errors, []);
  assert.deepEqual(r.detail.derived_conflicts, []);
});

test("真实数据的置信度来源：冷暖商品侧取来源记录 0.85（min 后 0.80），季型 / 副气取行内 0.80，无兜底", () => {
  const r = run();
  assert.equal(unit(r, "temperature").item_confidence_source, "field_source");
  assert.equal(unit(r, "temperature").item_confidence, 0.85);
  assert.equal(unit(r, "temperature").confidence, 0.8);
  assert.equal(unit(r, "season").item_confidence_source, "row");
  assert.equal(unit(r, "element").item_confidence_source, "row");
  assert.deepEqual(r.detail.item_confidence_fallback_units, []);
  assert.deepEqual(r.detail.human_confidence_fallback_units, []);
  assert.equal(unit(r, "season").human_confidence_source, "change_log");
  assert.ok(r.detail.shared_evidence_note.includes("同一来源"));
});

test("兜底标记：商品冷暖无来源记录 → fallback 0.80；人侧无变更记录 → no_record_fallback", () => {
  const r = run({
    item: { colorTemperature: { value: "neutral_warm", source: null } },
    human: { warmCool: { value: "warm", confidence: 0.8, confidenceSource: "no_record_fallback" } },
  });
  assert.equal(unit(r, "temperature").item_confidence_source, "fallback");
  assert.equal(unit(r, "temperature").item_confidence, 0.8);
  assert.deepEqual(r.detail.item_confidence_fallback_units, ["temperature"]);
  assert.deepEqual(r.detail.human_confidence_fallback_units, ["temperature"]);
  assert.equal(r.dimensionResult.score, 60);
});

// ── 三个单元全组合穷举 ─────────────────────────────────────────────
test("季型 25 格穷举：单元分等于矩阵值，且对称、同季 1.0", () => {
  let n = 0;
  for (const a of SEASON_VALUES) for (const b of SEASON_VALUES) {
    const r = run({ human: { seasonName: { value: a } }, item: { seasonName: { value: b, rowConfidence: "0.80" } } });
    const s = unit(r, "season").unit_score;
    assert.equal(s, COLOR_FIT_PARAMS.seasonSimilarity[a][b], `${a}/${b}`);
    assert.equal(s, COLOR_FIT_PARAMS.seasonSimilarity[b as Season][a as Season], `${a}/${b} 对称`);
    if (a === b) assert.equal(s, 1);
    n++;
  }
  assert.equal(n, 25);
});

test("五行 25 格穷举：同元素 1.0；相生 / 相克为无方向配对，交换顺序分值不变；5 + 5 组", () => {
  const gen = new Set(["木火", "火土", "土金", "金水", "水木"]);
  const over = new Set(["木土", "土水", "水火", "火金", "金木"]);
  let g = 0, o = 0;
  for (const a of ELEMENT_VALUES) for (const b of ELEMENT_VALUES) {
    const r = run({ human: { elementName: { value: a } }, item: { elementName: { value: b, rowConfidence: "0.80" } } });
    const s = unit(r, "element").unit_score;
    if (a === b) assert.equal(s, 1, `${a}/${b}`);
    else if (gen.has(a + b) || gen.has(b + a)) { assert.equal(s, 0.7, `${a}/${b} 相生`); g++; }
    else if (over.has(a + b) || over.has(b + a)) { assert.equal(s, 0.3, `${a}/${b} 相克`); o++; }
    else assert.fail(`${a}/${b} 未归类`);
  }
  assert.equal(g, 10);   // 5 组 × 两个方向
  assert.equal(o, 10);
});

test("冷暖 36 格穷举：轴上 4 值按距离给分；olive / uncertain 按缺失处理并写明原因，不给 0 分", () => {
  const axis: Record<string, number> = { cool: -2, neutral_cool: -1, neutral_warm: 1, warm: 2 };
  const table = [1, 0.8, 0.5, 0.25, 0];
  for (const a of WARM_COOL_VALUES) for (const b of WARM_COOL_VALUES) {
    const r = run({ human: { warmCool: { value: a } }, item: { colorTemperature: { value: b } } });
    const u = unit(r, "temperature");
    if (a in axis && b in axis) {
      assert.equal(u.status, "scored", `${a}/${b}`);
      assert.equal(u.unit_score, table[Math.abs(axis[a] - axis[b])], `${a}/${b}`);
    } else {
      assert.equal(u.status, "missing", `${a}/${b}`);
      assert.equal(u.unit_score, null);
      const expect = a === "uncertain" ? "human_uncertain" : a === "olive" ? "human_olive_semantics_unconfirmed"
        : b === "uncertain" ? "item_uncertain" : "item_olive_semantics_unconfirmed";
      assert.equal(u.missing_reason, expect, `${a}/${b}`);
    }
  }
});

test("冷暖关键对照：中性暖 ↔ 中性冷 0.5；暖 ↔ 冷 0（触发 CF_TEMP_CLASH）", () => {
  assert.equal(unit(run({ human: { warmCool: { value: "neutral_warm" } }, item: { colorTemperature: { value: "neutral_cool" } } }), "temperature").unit_score, 0.5);
  const r = run({ item: { colorTemperature: { value: "cool" } } });
  assert.equal(unit(r, "temperature").unit_score, 0);
  assert.ok(r.dimensionResult.warnings.includes("CF_TEMP_CLASH"));
  assert.ok(!r.dimensionResult.strengths.includes("CF_TEMP_MATCH"));
});

// ── 缺失单元归一化 ───────────────────────────────────────────────
test("只有冷暖有效：score = 冷暖单元分 × 100，data_coverage 0.4", () => {
  const r = run({ item: { identityRows: 0 } });
  assert.equal(r.dimensionResult.score, 80);
  assert.equal(r.exact.data_coverage, 0.4);
  assert.equal(r.dimensionResult.rule_coverage, 1);
  assert.equal(unit(r, "season").missing_reason, "item_value_missing");
});

test("olive 人侧：冷暖缺失，季型 + 副气归一化 → (0.4×0.2 + 0.2×1) ÷ 0.6 = 46.67", () => {
  const r = run({ human: { warmCool: { value: "olive" } } });
  assert.equal(r.dimensionResult.score, 46.67);
  assert.equal(r.dimensionResult.data_coverage, 0.6);
  assert.ok(!r.dimensionResult.strengths.includes("CF_TEMP_MATCH"));
});

test("只有副气有效：data_coverage 原始值 0.20 < 门槛，汇总判 invalid；三项资格仍为 true", () => {
  const r = run({ human: { warmCool: { value: null }, seasonName: { value: null } } });
  assert.equal(r.dimensionResult.score, 100);
  assert.equal(r.exact.data_coverage, 0.2);
  assert.ok(r.exact.data_coverage < MIN_DIMENSION_DATA_COVERAGE);
  assert.deepEqual(r.dimensionResult.eligibility, { purchase: true, recommendation: true, styling: true });
  const out = aggregate({ dimensions: { color_fit: toInput(r) }, scenario: null, priority: null, profile_version: 13 });
  assert.equal(out.dimensions.color_fit!.state, "invalid");
  assert.equal(out.purchase_eligibility, true);
});

test("全部缺失：score / confidence / rule_coverage 为 null，data_coverage 0，skip_reason no_scorable_units", () => {
  const r = run({ human: { warmCool: { value: "uncertain" }, seasonName: { value: null }, elementName: { value: null } } });
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.dimensionResult.confidence, null);
  assert.equal(r.dimensionResult.rule_coverage, null);
  assert.equal(r.dimensionResult.data_coverage, 0);
  assert.equal(r.detail.skip_reason, "no_scorable_units");
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, []);
});

// ── 变体与商品行 ─────────────────────────────────────────────────
test("变体：多个变体未指定 → variant_required；商品无变体 / 变体无色彩行 → item_color_missing", () => {
  const a = run({ variantResolution: "ambiguous" });
  assert.equal(a.detail.skip_reason, "variant_required");
  assert.equal(a.dimensionResult.score, null);
  assert.equal(a.detail.units.length, 0);
  assert.equal(run({ variantResolution: "none" }).detail.skip_reason, "item_color_missing");
  const b = run({ item: { attributesRows: 0, identityRows: 0 } });
  assert.equal(b.detail.skip_reason, "item_color_missing");
  assert.equal(b.dimensionResult.data_coverage, 0);
  assert.equal(run({ variantResolution: "explicit" }).detail.variant_resolution, "explicit");
});

// ── 置信度 ───────────────────────────────────────────────────────
test("置信度：各单元取两侧较小值，再按有效单元权重平均", () => {
  // 冷暖 min(0.9, 来源 stylist 0.95)=0.9；季型 min(0.7, 0.85)=0.7；副气 min(0.95, 0.85)=0.85
  const r = run({
    human: { warmCool: { confidence: 0.9 }, seasonName: { confidence: 0.7 }, elementName: { confidence: 0.95 } },
    item: {
      colorTemperature: { value: "neutral_warm", source: { sourceMethod: "stylist", verifiedStatus: "verified" } },
      seasonName: { value: "秋", rowConfidence: "0.85" },
      elementName: { value: "木", rowConfidence: "0.85" },
    },
  });
  assert.equal(unit(r, "temperature").confidence, 0.9);
  assert.equal(unit(r, "temperature").item_confidence_source, "field_source");
  assert.equal(r.dimensionResult.confidence, Math.round(((0.4 * 0.9 + 0.4 * 0.7 + 0.2 * 0.85) / 1) * 1000) / 1000);
});

test("来源 rejected：该单元证据作废按缺失处理，不给 0 分", () => {
  const r = run({ item: { colorTemperature: { value: "neutral_warm", source: { sourceMethod: "manual_operator", verifiedStatus: "rejected" } } } });
  assert.equal(unit(r, "temperature").status, "missing");
  assert.equal(unit(r, "temperature").missing_reason, "item_evidence_rejected");
  assert.equal(r.exact.data_coverage, 0.6);
  assert.equal(r.dimensionResult.score, 46.67);
});

// ── 校验与边界输入 ───────────────────────────────────────────────
test("非法值（含 toString、__proto__ 等属性名）记 unit_validation_errors，单元缺失而不是 0 分", () => {
  for (const bad of ["toString", "__proto__", "constructor", "neutral", "Warm", "春季"]) {
    const r = run({ human: { warmCool: { value: bad }, seasonName: { value: bad } }, item: { elementName: { value: bad, rowConfidence: "0.8" } } });
    for (const u of ["temperature", "season", "element"]) {
      assert.equal(unit(r, u).status, "missing", `${bad} / ${u}`);
      assert.equal(unit(r, u).unit_score, null);
    }
    assert.equal(r.detail.unit_validation_errors.length, 3, bad);
    assert.equal(r.dimensionResult.score, null);
  }
});

test("置信度越界：行内 1.5 / 人侧 NaN 记校验错误，该单元缺失", () => {
  const r = run({ item: { seasonName: { value: "秋", rowConfidence: "1.5" } }, human: { elementName: { confidence: NaN } } });
  assert.equal(unit(r, "season").missing_reason, "item_confidence_invalid");
  assert.equal(unit(r, "element").missing_reason, "human_confidence_invalid");
  assert.equal(r.detail.unit_validation_errors.length, 2);
  assert.equal(r.dimensionResult.score, 80);
});

test("原因码只输出 matching_reason_codes 里方向一致的码", () => {
  const r = run({ reasonDir: new Map([["CF_TEMP_MATCH", "warning"]]) });
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, []);
  const s = run({ item: { seasonName: { value: "夏", rowConfidence: "0.8" } } });
  assert.ok(s.dimensionResult.strengths.includes("CF_SEASON_MATCH"));
  assert.ok(!s.dimensionResult.warnings.includes("CF_SEASON_CLASH"));
});

test("原因码文案与 03A Part D 第七节一致，且不表达禁止", () => {
  assert.deepEqual(COLOR_FIT_REASONS.map(r => [r.code, r.direction, r.meaning]), [
    ["CF_TEMP_MATCH", "strength", "这件单品的冷暖倾向与你较协调"],
    ["CF_SEASON_MATCH", "strength", "这件单品与你的季型一致"],
    ["CF_TEMP_CLASH", "warning", "冷暖方向差异较明显，可通过搭配衔接"],
    ["CF_SEASON_CLASH", "warning", "季型色彩方向差异较大，可调整搭配面积"],
  ]);
  for (const r of COLOR_FIT_REASONS) assert.ok(!/不要|禁止|不能|避免|不适合/.test(r.meaning), r.code);
});

// ── 派生字段一致性（Q7：停用受影响单元并记录诊断，不改原值）──────────────
test("Q7 商品 秋 → 土（10-04 修正前的真实数据）：只停用季型，冷暖 + 副气归一化 → 86.67", () => {
  const r = run({ item: { seasonName: { value: "秋", rowConfidence: "0.80" }, elementName: { value: "木", rowConfidence: "0.80" }, seasonElement: "土", finalSeason25: "秋木" } });
  assert.equal(unit(r, "season").status, "missing");
  assert.equal(unit(r, "season").missing_reason, "item_derived_conflict");
  assert.equal(unit(r, "element").status, "scored");
  assert.equal(unit(r, "temperature").status, "scored");
  assert.equal(r.dimensionResult.score, 86.67);   // (0.32 + 0.20) ÷ 0.6
  assert.equal(r.dimensionResult.data_coverage, 0.6);
  assert.deepEqual(r.detail.derived_conflicts, [
    { side: "item", field: "season_element", actual: "土", expected: "金", disabled_units: ["season"] },
  ]);
  assert.ok(!r.dimensionResult.warnings.includes("CF_SEASON_CLASH"), "停用的单元不触发原因码");
});

test("Q7 final_season_25：季名不符停季型，五行不符停副气，都不符两项都停", () => {
  const item = (f25: string) => run({ item: { seasonName: { value: "秋", rowConfidence: "0.8" }, elementName: { value: "木", rowConfidence: "0.8" }, seasonElement: "金", finalSeason25: f25 } });
  const a = item("秋水");
  assert.deepEqual(a.detail.derived_conflicts.map(c => c.disabled_units), [["element"]]);
  assert.equal(a.dimensionResult.score, 50);       // (0.32 + 0.08) ÷ 0.8
  const b = item("冬木");
  assert.deepEqual(b.detail.derived_conflicts.map(c => c.disabled_units), [["season"]]);
  const c = item("冬水");
  assert.deepEqual(c.detail.derived_conflicts[0].disabled_units, ["season", "element"]);
  assert.equal(c.dimensionResult.score, 80);       // 只剩冷暖
  assert.equal(c.detail.derived_conflicts[0].expected, "秋木");
});

test("Q7 final_season_25 无法拆解（如 长夏·深木）：季型、副气都停，冷暖不受影响", () => {
  const r = run({ human: { seasonName: { value: "长夏" }, elementName: { value: "木" } }, humanDerived: { seasonElement: "土", finalSeason25: "长夏·深木" } });
  assert.equal(unit(r, "season").missing_reason, "human_derived_conflict");
  assert.equal(unit(r, "element").missing_reason, "human_derived_conflict");
  assert.equal(unit(r, "temperature").status, "scored");
  assert.equal(r.dimensionResult.score, 80);
  assert.equal(r.detail.derived_conflicts[0].side, "human");
});

test("Q7 人侧冲突与商品侧冲突分别检查；同一单元被两个派生字段命中只停一次", () => {
  const r = run({
    human: { seasonName: { value: "夏" }, elementName: { value: "木" } },
    humanDerived: { seasonElement: "木", finalSeason25: "春木" },
  });
  assert.equal(r.detail.derived_conflicts.length, 2);
  assert.ok(r.detail.derived_conflicts.every(c => c.side === "human"));
  assert.equal(unit(r, "season").missing_reason, "human_derived_conflict");
  assert.equal(r.detail.units.filter(u => u.unit === "season").length, 1);
});

test("Q7 派生字段缺失不算冲突、不反推；派生字段与基础字段一致时正常计分", () => {
  const r = run({ humanDerived: { seasonElement: null, finalSeason25: null }, item: { seasonElement: null, finalSeason25: null } });
  assert.deepEqual(r.detail.derived_conflicts, []);
  assert.equal(r.dimensionResult.score, 60);
  const ok = run({ human: { seasonName: { value: "长夏" }, elementName: { value: "土" } }, humanDerived: { seasonElement: "土", finalSeason25: "长夏土" } });
  assert.deepEqual(ok.detail.derived_conflicts, []);
});

// ── 商品色彩行异常 ───────────────────────────────────────────────
test("同一变体有多行 color_identity：该组不使用（不挑其中一行），记校验错误，冷暖照常计分", () => {
  const r = run({ item: { identityRows: 2 } });
  assert.equal(unit(r, "season").missing_reason, "item_rows_duplicate");
  assert.equal(unit(r, "element").missing_reason, "item_rows_duplicate");
  assert.equal(r.detail.unit_validation_errors.filter(e => e.reason === "duplicate_rows").length, 1);
  assert.equal(r.dimensionResult.score, 80);
  assert.deepEqual(r.detail.derived_conflicts, [], "重复行不做派生检查");
});

// ── 汇总层接入 ───────────────────────────────────────────────────
test("五行方向只写入 detail，不改变分数：我生 / 生我同为 0.7，我克 / 克我同为 0.3", () => {
  const el = (h: string, i: string) => run({ human: { elementName: { value: h } }, item: { elementName: { value: i, rowConfidence: "0.80" } } });
  const cases: [string, string, string, string | null, number][] = [
    ["木", "木", "same", null, 1.0],
    ["木", "火", "generating", "human_generates_item", 0.7],
    ["火", "木", "generating", "item_generates_human", 0.7],
    ["木", "土", "overcoming", "human_overcomes_item", 0.3],
    ["土", "木", "overcoming", "item_overcomes_human", 0.3],
  ];
  for (const [h, i, relation, direction, s] of cases) {
    const r = el(h, i);
    assert.equal(unit(r, "element").unit_score, s, `${h}/${i}`);
    assert.deepEqual(r.detail.element_relation, { relation, direction, scored_with_direction: false }, `${h}/${i}`);
  }
  assert.equal(el("木", "火").dimensionResult.score, el("火", "木").dimensionResult.score, "方向相反、分数相同");
  assert.deepEqual(el("木", "土").dimensionResult.eligibility, { purchase: true, recommendation: true, styling: true }, "相克不影响资格");
  assert.equal(run().detail.element_relation?.relation, "same", "真实快照：人 木 × 商品 木");
  assert.equal(run({ item: { elementName: { value: null } } }).detail.element_relation, null, "副气单元缺失时不记录关系");
});

test("olive：任一侧为 olive，冷暖单元按缺失处理，季型与副气照常计分", () => {
  const h = run({ human: { warmCool: { value: "olive" } } });
  assert.equal(unit(h, "temperature").status, "missing");
  assert.equal(unit(h, "temperature").missing_reason, "human_olive_semantics_unconfirmed");
  const i = run({ item: { colorTemperature: { value: "olive", source: { sourceMethod: "manual_operator", verifiedStatus: "unverified", confidence: "0.85" } } } });
  assert.equal(unit(i, "temperature").missing_reason, "item_olive_semantics_unconfirmed");
  for (const r of [h, i]) {
    assert.equal(unit(r, "season").status, "scored");
    assert.equal(unit(r, "element").status, "scored");
    assert.equal(r.exact.data_coverage, 0.6, "冷暖 0.4 不贡献覆盖率");
  }
});

test("写入端一致性：真实数据 秋/金/木/秋木 通过；10-04 前的 秋 → 土 被拒绝；全部为空也通过", () => {
  const ok = { seasonName: "秋", seasonElement: "金", elementName: "木", finalSeason25: "秋木" };
  assert.deepEqual(checkColorIdentityConsistency(ok), []);
  assert.deepEqual(checkColorIdentityConsistency({ ...ok, seasonElement: "土" }),
    [{ field: "season_element", reason: "mismatch", actual: "土", expected: "金" }]);
  assert.deepEqual(checkColorIdentityConsistency({ seasonName: null, seasonElement: null, elementName: null, finalSeason25: null }), []);
  assert.deepEqual(checkColorIdentityConsistency({ seasonName: "长夏", seasonElement: "土", elementName: null, finalSeason25: null }), [], "只填基础字段与对应主气");
  for (const s of SEASON_VALUES) {
    for (const e of ELEMENT_VALUES) {
      const all = checkColorIdentityConsistency({ seasonName: s, seasonElement: COLOR_SEASON_MAIN[s], elementName: e, finalSeason25: `${s}${e}` });
      assert.deepEqual(all, [], `${s}${e} 应通过`);
    }
  }
});

test("写入端一致性：final_season_25 季名或五行不符、无法拆解、缺基础字段 → 逐项报出", () => {
  const base = { seasonName: "秋", seasonElement: "金", elementName: "木", finalSeason25: "秋木" };
  assert.deepEqual(checkColorIdentityConsistency({ ...base, finalSeason25: "夏木" }),
    [{ field: "final_season_25", reason: "mismatch", actual: "夏木", expected: "秋木" }]);
  assert.deepEqual(checkColorIdentityConsistency({ ...base, finalSeason25: "秋水" })[0].reason, "mismatch");
  assert.deepEqual(checkColorIdentityConsistency({ ...base, finalSeason25: "长夏·深木" })[0].reason, "unparseable");
  assert.deepEqual(checkColorIdentityConsistency({ ...base, elementName: null })[0],
    { field: "final_season_25", reason: "base_missing", actual: "秋木", expected: null });
  assert.deepEqual(checkColorIdentityConsistency({ ...base, seasonName: null, finalSeason25: null })[0],
    { field: "season_element", reason: "base_missing", actual: "金", expected: null });
  assert.equal(checkColorIdentityConsistency({ seasonName: "夏", seasonElement: "土", elementName: "木", finalSeason25: "秋木" }).length, 2, "两处都错时都报出");
});

test("接入七维汇总：Body / Face / Style 基准 + Color 预演值 → 4 个有效维度", () => {
  const dim = (score: number, dc: number): DimensionInput => ({
    score, data_coverage: dc, rule_coverage: 1, confidence: 0.8,
    eligibility: { purchase: true, recommendation: true, styling: true },
    strengths: [], warnings: [], unit_validation_error_count: 0, engine_version: "matching_v1.0", rule_versions: ["v1.0"],
  });
  const out = aggregate({
    dimensions: { body_fit: dim(62.69, 0.867), face_fit: dim(58.55, 1), style_fit: dim(54.8, 0.43), color_fit: toInput(run()) },
    scenario: null, priority: null, profile_version: 13,
  });
  assert.equal(out.overall_status, "ok");
  assert.equal(out.valid_dimensions, 4);
  assert.equal(out.dimensions.color_fit!.state, "valid");
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); process.exitCode = 1; }
}
console.log(`\nmatching-color: ${passed}/${tests.length} 通过`);
