// 运行：npm run test:matching（或 npx tsx tests/matching-color.test.ts）
// 离线测试 matching-color.ts，不连数据库。覆盖 03A Part D Color Fit V0.1：枚举与 schema 一致、
// 配置自洽校验、三个单元的全组合穷举、缺失归一化、覆盖率与置信度、原因码、变体与缺失处理、汇总层接入。
// 测试数据取自 2026-10-04 线上查询：AIFFD_PROFILE_000001（版本 13）× AIFFD_VARIANT_000001（ITEM_000002）。
// 注意：60.00 是草案矩阵下的预演值，不是正式 Color Fit 基准。
import assert from "node:assert/strict";
import {
  computeColorFit, validateColorFitParams, COLOR_FIT_PARAMS, COLOR_FIT_REASONS, ColorFitParams, ColorFitInput,
  WARM_COOL_VALUES, SEASON_VALUES, ELEMENT_VALUES, Season,
} from "../api/routes/matching-color";
import { aggregate, DimensionInput, MIN_DIMENSION_DATA_COVERAGE } from "../api/routes/matching-aggregate";
import { humanStyleProfiles, fashionVariantColorAttributes, fashionVariantColorIdentity } from "../db/schema";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const allReasons = () => new Map<string, string>(COLOR_FIT_REASONS.map(r => [r.code, r.direction]));
const clone = (): ColorFitParams => JSON.parse(JSON.stringify(COLOR_FIT_PARAMS));

type Over = {
  human?: Partial<Record<"warmCool" | "seasonName" | "elementName", { value?: unknown; confidence?: number }>>;
  item?: Partial<ColorFitInput["item"]>;
  variantResolution?: ColorFitInput["variantResolution"];
  reasonDir?: Map<string, string>;
  params?: ColorFitParams;
};
// 基准：测试账号 暖 / 夏 / 木（来源 color_test → 0.8）；变体 neutral_warm（无来源记录）/ 秋 / 木（行内 0.80，decimal 字符串）
const run = (o: Over = {}) => computeColorFit({
  variantResolution: o.variantResolution ?? "auto_single",
  human: {
    warmCool: { value: "warm", confidence: 0.8, ...o.human?.warmCool },
    seasonName: { value: "夏", confidence: 0.8, ...o.human?.seasonName },
    elementName: { value: "木", confidence: 0.8, ...o.human?.elementName },
  },
  item: {
    hasAttributesRow: true,
    hasIdentityRow: true,
    colorTemperature: { value: "neutral_warm", source: null },
    seasonName: { value: "秋", rowConfidence: "0.80" },
    elementName: { value: "木", rowConfidence: "0.80" },
    ...o.item,
  },
  reasonDir: o.reasonDir ?? allReasons(),
  params: o.params,
});
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
test("默认配置通过自洽校验，整体标记 provisional，已确认项只有权重与归一化", () => {
  assert.deepEqual(validateColorFitParams(COLOR_FIT_PARAMS), []);
  assert.equal(COLOR_FIT_PARAMS.status, "provisional");
  const confirmed = Object.entries(COLOR_FIT_PARAMS.paramStatus).filter(([, s]) => s === "confirmed").map(([k]) => k);
  assert.deepEqual(confirmed.sort(), ["missing_unit_normalization", "unit_weights"]);
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
});

test("商品侧兜底置信度在明细中标记：冷暖无来源记录 → fallback 0.80", () => {
  const r = run();
  assert.equal(unit(r, "temperature").item_confidence_source, "fallback");
  assert.equal(unit(r, "temperature").item_confidence, 0.8);
  assert.equal(unit(r, "season").item_confidence_source, "row");
  assert.deepEqual(r.detail.item_confidence_fallback_units, ["temperature"]);
  assert.ok(r.detail.shared_evidence_note.includes("同一来源"));
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
  const r = run({ item: { hasIdentityRow: false } });
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
  const b = run({ item: { hasAttributesRow: false, hasIdentityRow: false } });
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

test("原因码文案不表达禁止", () => {
  for (const r of COLOR_FIT_REASONS) assert.ok(!/不要|禁止|不能|避免|不适合/.test(r.meaning), r.code);
});

// ── 汇总层接入 ───────────────────────────────────────────────────
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
