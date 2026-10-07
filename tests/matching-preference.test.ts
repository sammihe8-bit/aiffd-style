// 运行：npm run test:matching（或 npx tsx tests/matching-preference.test.ts）
// 离线测试 matching-preference.ts，不连数据库。对齐 03A Part E Preference Fit V0.1：
// 第九节构造例 A～D、第十节校验与验收用例，以及测试账号真实快照的预演值。
// 真实快照（2026-10-06）：AIFFD_PROFILE_000001 版本 14 × AIFFD_ITEM_000002 商品级 7 行评估
//   理想 clean_intellectual / relaxed_natural / refined_elegant（★refined_elegant）
//   排斥 soft_romantic / glamorous_mature / oriental_refined；两题来源 fashion_preference_test（0.80）
//   商品 clean_intellectual 1.00、relaxed_natural 1.00、refined_elegant 0.50、soft_romantic 0.50、
//        urban_modern 0.50、glamorous_mature 0.00、androgynous_sharp 0.00，confidence 均 0.80，manual_operator / unverified
// 注意：88.89 是 provisional 参数下的预演值，不是正式 Preference Fit 基准。
import assert from "node:assert/strict";
import {
  computePreferenceFit, validatePreferenceFitParams, PREFERENCE_FIT_PARAMS, PREFERENCE_FIT_REASONS,
  PreferenceFitInput, ItemImageTagRow,
} from "../api/routes/matching-preference";
import { aggregate, DimensionInput, MIN_DIMENSION_DATA_COVERAGE } from "../api/routes/matching-aggregate";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const allReasons = () => new Map<string, string>(PREFERENCE_FIT_REASONS.map(r => [r.code, r.direction]));
const row = (tagId: string, score: number | string, extra: Partial<ItemImageTagRow> = {}): ItemImageTagRow => ({
  tagId, score: typeof score === "number" ? score.toFixed(2) : score, confidence: "0.80",
  sourceMethod: "manual_operator", verifiedStatus: "unverified", variantId: null, ...extra,
});
const ITEM_000002: ItemImageTagRow[] = [
  row("clean_intellectual", 1), row("relaxed_natural", 1), row("refined_elegant", 0.5), row("soft_romantic", 0.5),
  row("urban_modern", 0.5), row("glamorous_mature", 0), row("androgynous_sharp", 0),
];
type Over = {
  aspired?: unknown; favorite?: unknown; rejected?: unknown;
  aspiredConf?: number; rejectedConf?: number; aspiredSrc?: "change_log" | "no_record_fallback";
  rows?: ItemImageTagRow[]; reasonDir?: Map<string, string>; params?: PreferenceFitInput["params"];
};
const run = (o: Over = {}) => computePreferenceFit({
  human: {
    aspiredImageTags: "aspired" in o ? o.aspired : '["clean_intellectual","relaxed_natural","refined_elegant"]',
    aspiredImageTagFavorite: "favorite" in o ? o.favorite : "refined_elegant",
    rejectedImageTags: "rejected" in o ? o.rejected : '["soft_romantic","glamorous_mature","oriental_refined"]',
    aspiredConfidence: { confidence: o.aspiredConf ?? 0.8, confidenceSource: o.aspiredSrc ?? "change_log" },
    rejectedConfidence: { confidence: o.rejectedConf ?? 0.8, confidenceSource: "change_log" },
  },
  itemRows: o.rows ?? ITEM_000002,
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

// 第九节构造例：理想 简洁知性 / 松弛自然 / 个性艺术，排斥 华丽成熟 / 温柔浪漫，最喜欢未标记
const EX_ASPIRED = '["clean_intellectual","relaxed_natural","artistic_individual"]';
const EX_REJECTED = '["soft_romantic","glamorous_mature"]';
const EX_ROWS = [row("clean_intellectual", 1), row("relaxed_natural", 0.5), row("artistic_individual", 0), row("glamorous_mature", 0.5), row("soft_romantic", 0)];
const ex = (o: Over = {}) => run({ aspired: EX_ASPIRED, rejected: EX_REJECTED, favorite: null, rows: EX_ROWS, ...o });

// ── 配置 ──────────────────────────────────────────────────────────
test("默认配置自洽，整体 provisional；权重 70/30，阈值 0.75 / 0.50", () => {
  assert.deepEqual(validatePreferenceFitParams(PREFERENCE_FIT_PARAMS), []);
  assert.equal(PREFERENCE_FIT_PARAMS.status, "provisional");
  assert.deepEqual(PREFERENCE_FIT_PARAMS.weights, { aspired: 0.7, rejected: 0.3 });
  assert.deepEqual(PREFERENCE_FIT_PARAMS.thresholds, { echo: 0.75, conflict: 0.5 });
  const bad = JSON.parse(JSON.stringify(PREFERENCE_FIT_PARAMS));
  bad.weights.rejected = 0.4;
  assert.ok(validatePreferenceFitParams(bad).some(p => p.includes("合计应为 1")));
  assert.throws(() => run({ params: bad }), /PREFERENCE_FIT_PARAMS_INVALID/);
});

// ── 真实快照预演 ───────────────────────────────────────────────────
test("测试账号 × ITEM_000002：88.89 / 0.900 / 1 / 0.800（预演值）", () => {
  const r = run();
  assert.equal(r.dimensionResult.score, 88.89);
  assert.equal(r.dimensionResult.data_coverage, 0.9);
  assert.equal(r.exact.data_coverage, 0.9);
  assert.equal(r.dimensionResult.rule_coverage, 1);
  assert.equal(r.dimensionResult.confidence, 0.8);
  const d = unit(r, "aspired"), x = unit(r, "rejected");
  assert.equal(d.unit_score, 1);
  assert.equal(d.coverage, 1);
  assert.deepEqual(d.max_tags, ["clean_intellectual", "relaxed_natural"], "并列最高全部记录");
  assert.equal(x.unit_score, 0.5);
  assert.equal(Math.round(x.coverage * 1e6) / 1e6, Math.round((2 / 3) * 1e6) / 1e6);
  assert.deepEqual(x.unknown_tags, ["oriental_refined"]);
  assert.deepEqual(x.max_tags, ["soft_romantic"]);
  assert.equal(x.contribution_weight, 0.2, "单元贡献权重不带浮点噪声");
  assert.equal(d.contribution_weight, 0.7);
  assert.equal(r.detail.evidence_scope, "aspiration_and_avoidance");
  assert.equal(r.detail.expected_weight, 1);
  assert.equal(r.detail.contribution_weight, 0.9);
});

test("真实快照原因码：理想呼应触发；最喜欢 refined_elegant 只有 0.50 不触发；排斥 0.50 恰在边界触发", () => {
  const r = run();
  assert.deepEqual(r.dimensionResult.strengths, ["PF_ASPIRED_ECHO"]);
  assert.deepEqual(r.dimensionResult.warnings, ["PF_REJECTED_CONFLICT"]);
  const fav = r.detail.reason_basis.find(b => b.code === "PF_FAVORITE_ECHO")!;
  assert.equal(fav.triggered, false);
  assert.equal(fav.value, 0.5);
});

test("ITEM_000001（没有任何评估）：score / confidence / rule_coverage 为 null，coverage 0，原因码为空", () => {
  const r = run({ rows: [] });
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.dimensionResult.confidence, null);
  assert.equal(r.dimensionResult.rule_coverage, null);
  assert.equal(r.dimensionResult.data_coverage, 0);
  assert.equal(r.detail.skip_reason, "no_relevant_assessments");
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, []);
});

// ── 第九节构造例 ─────────────────────────────────────────────────
test("例 A：全部相关标签已评估 → 85.00，coverage 1；strengths [PF_ASPIRED_ECHO]，warnings [PF_REJECTED_CONFLICT]", () => {
  const r = ex();
  assert.equal(r.dimensionResult.score, 85);
  assert.equal(r.dimensionResult.data_coverage, 1);
  assert.equal(r.dimensionResult.rule_coverage, 1);
  assert.deepEqual(r.dimensionResult.strengths, ["PF_ASPIRED_ECHO"]);
  assert.deepEqual(r.dimensionResult.warnings, ["PF_REJECTED_CONFLICT"]);
});

test("例 B：理想只评估简洁知性 1.00 → 71.88，coverage 0.533；未知理想标签列入 detail", () => {
  const r = ex({ rows: [row("clean_intellectual", 1), row("glamorous_mature", 0.5), row("soft_romantic", 0)] });
  assert.equal(r.dimensionResult.score, 71.88);
  assert.equal(r.dimensionResult.data_coverage, 0.533);
  assert.deepEqual(unit(r, "aspired").unknown_tags, ["relaxed_natural", "artistic_individual"]);
  assert.deepEqual(r.dimensionResult.strengths, ["PF_ASPIRED_ECHO"]);
  assert.deepEqual(r.dimensionResult.warnings, ["PF_REJECTED_CONFLICT"]);
});

test("例 C：明确无排斥 R = [] → 100.00，coverage 1，排斥单元不适用；R 为 NULL → 100.00，coverage 0.700", () => {
  const c = ex({ rejected: "[]" });
  assert.equal(c.dimensionResult.score, 100);
  assert.equal(c.dimensionResult.data_coverage, 1);
  assert.equal(unit(c, "rejected").status, "not_applicable");
  assert.equal(unit(c, "rejected").expected_weight, 0);
  assert.deepEqual(c.dimensionResult.warnings, []);
  const n = ex({ rejected: null });
  assert.equal(n.dimensionResult.score, 100);
  assert.equal(n.dimensionResult.data_coverage, 0.7);
  assert.equal(unit(n, "rejected").status, "unanswered");
  assert.equal(n.detail.evidence_scope, "aspiration_only");
});

test("例 D：理想 NULL、只有排斥可算 → 50.00，coverage 0.300 达到门槛，evidence_scope = avoidance_only", () => {
  const r = ex({ aspired: null });
  assert.equal(r.dimensionResult.score, 50);
  assert.equal(r.exact.data_coverage, 0.3);
  assert.ok(r.exact.data_coverage >= MIN_DIMENSION_DATA_COVERAGE);
  assert.equal(r.detail.evidence_scope, "avoidance_only");
  assert.deepEqual(r.dimensionResult.strengths, [], "没有理想证据，不能声称呼应");
});

test("覆盖率表：理想 3 项只评估 1 项、排斥 [] → 0.333", () => {
  const r = ex({ rejected: "[]", rows: [row("clean_intellectual", 1)] });
  assert.equal(r.dimensionResult.data_coverage, 0.333);
  assert.equal(r.dimensionResult.score, 100);
});

// ── 第十节：校验与验收用例 ─────────────────────────────────────────
test("score = 0 是合法证据：理想全部评估为 0 → 理想单元 0 分且计入覆盖，不按真假值过滤", () => {
  const r = ex({ rejected: "[]", rows: [row("clean_intellectual", 0), row("relaxed_natural", 0), row("artistic_individual", 0)] });
  assert.equal(r.dimensionResult.score, 0);
  assert.equal(r.dimensionResult.data_coverage, 1);
  assert.equal(unit(r, "aspired").status, "scored");
  assert.deepEqual(r.dimensionResult.strengths, []);
});

test("只有非相关标签被评估 → 与无相关评估相同，不能拉高 coverage", () => {
  const r = run({ rows: [row("urban_modern", 1), row("androgynous_sharp", 1), row("vintage_literary", 0)] });
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.dimensionResult.data_coverage, 0);
  assert.equal(r.detail.skip_reason, "no_relevant_assessments");
});

test("rejected 商品记录视为未评估：不贡献最高值、覆盖或原因码", () => {
  const rows = EX_ROWS.map(x => x.tagId === "glamorous_mature" ? { ...x, score: "1.00", verifiedStatus: "rejected" } : x);
  const r = ex({ rows });
  assert.equal(unit(r, "rejected").unit_score, 1, "剩下的温柔浪漫 0 → 避让 1");
  assert.equal(unit(r, "rejected").coverage, 0.5);
  assert.deepEqual(r.dimensionResult.warnings, [], "被 rejected 的高分记录不触发冲突");
  assert.deepEqual(r.detail.item_rows_rejected, ["glamorous_mature"]);
});

test("行顺序变化不影响结果；并列最高标签按固定顺序稳定记录", () => {
  const a = ex(), b = ex({ rows: [...EX_ROWS].reverse() });
  assert.equal(a.dimensionResult.score, b.dimensionResult.score);
  assert.equal(a.dimensionResult.data_coverage, b.dimensionResult.data_coverage);
  assert.equal(a.dimensionResult.confidence, b.dimensionResult.confidence);
  const r1 = run(), r2 = run({ rows: [...ITEM_000002].reverse() });
  assert.deepEqual(unit(r1, "aspired").max_tags, unit(r2, "aspired").max_tags);
});

test("最喜欢与理想最高不同：不改变分数；最喜欢达到阈值时展示 PF_FAVORITE_ECHO 并抑制 PF_ASPIRED_ECHO", () => {
  const base = ex({ favorite: "relaxed_natural" });
  assert.equal(base.dimensionResult.score, 85);
  assert.deepEqual(base.dimensionResult.strengths, ["PF_ASPIRED_ECHO"], "最喜欢只有 0.50，不触发专属码");
  const fav = ex({ favorite: "clean_intellectual" });
  assert.equal(fav.dimensionResult.score, 85, "最喜欢不加权");
  assert.deepEqual(fav.dimensionResult.strengths, ["PF_FAVORITE_ECHO"]);
  assert.equal(fav.detail.reason_basis.find(x => x.code === "PF_ASPIRED_ECHO")!.triggered, true, "内部依据仍保留");
});

test("阈值含边界：理想 0.75 触发呼应；排斥 0.50 触发冲突、0.49 不触发", () => {
  const e = ex({ rejected: "[]", rows: [row("clean_intellectual", 0.75)] });
  assert.deepEqual(e.dimensionResult.strengths, ["PF_ASPIRED_ECHO"]);
  const c1 = ex({ rows: [row("clean_intellectual", 1), row("glamorous_mature", 0.5)] });
  assert.deepEqual(c1.dimensionResult.warnings, ["PF_REJECTED_CONFLICT"]);
  const c2 = ex({ rows: [row("clean_intellectual", 1), row("glamorous_mature", 0.49)] });
  assert.deepEqual(c2.dimensionResult.warnings, []);
});

test("覆盖门槛用原始值：0.2996 不因展示为 0.300 而有效（直接用汇总层核对）", () => {
  const r = ex({ aspired: null });
  const input = { ...toInput(r), data_coverage: 0.2996 };
  const out = aggregate({ dimensions: { preference_fit: input }, scenario: null, priority: null, profile_version: 14 });
  assert.equal(out.dimensions.preference_fit!.state, "invalid");
});

test("人侧非法历史数据 → 整维不计算并记录错误：理想 []、数量越界、未知 id、理想与排斥重叠、最喜欢不在理想里", () => {
  const cases: [Over, string][] = [
    [{ aspired: "[]" }, "count_out_of_range"],
    [{ aspired: '["clean_intellectual","relaxed_natural"]' }, "count_out_of_range"],
    [{ aspired: '["clean_intellectual","relaxed_natural","R"]' }, "unknown_tag"],
    [{ aspired: '["clean_intellectual","clean_intellectual","relaxed_natural"]' }, "duplicate_tag"],
    [{ aspired: "坏数据" }, "not_a_tag_array"],
    [{ rejected: '["refined_elegant"]' }, "overlap"],
    [{ favorite: "urban_modern" }, "not_in_aspired"],
    [{ rejected: '["__proto__"]' }, "unknown_tag"],
  ];
  for (const [o, reason] of cases) {
    const r = run(o);
    assert.equal(r.dimensionResult.score, null, reason);
    assert.equal(r.detail.skip_reason, "input_invalid", reason);
    assert.ok(r.detail.unit_validation_errors.some(e => e.reason === reason), `${reason}：${JSON.stringify(r.detail.unit_validation_errors)}`);
    assert.ok(r.detail.units.every(u => u.status === "input_invalid"));
  }
});

test("商品异常 → 整维不计算：同标签重复行、非法 score、非法 confidence、未知标签", () => {
  const cases: [ItemImageTagRow[], string][] = [
    [[...ITEM_000002, row("clean_intellectual", 0)], "duplicate_rows"],
    [[row("clean_intellectual", "1.5")], "score_out_of_range"],
    [[row("clean_intellectual", "abc")], "score_out_of_range"],
    [[row("clean_intellectual", 1, { confidence: "2" })], "confidence_out_of_range"],
    [[row("R", 1)], "unknown_tag"],
  ];
  for (const [rows, reason] of cases) {
    const r = run({ rows });
    assert.equal(r.dimensionResult.score, null, reason);
    assert.equal(r.detail.skip_reason, "input_invalid", reason);
    assert.ok(r.detail.unit_validation_errors.some(e => e.reason === reason), reason);
  }
});

test("V1 只读商品级行：带 variant_id 的行忽略并计数", () => {
  const r = run({ rows: [...ITEM_000002, row("oriental_refined", 1, { variantId: "AIFFD_VARIANT_000001" })] });
  assert.equal(r.dimensionResult.score, 88.89, "变体行里的东方雅致 1.00 不参与");
  assert.equal(r.detail.variant_rows_ignored, 1);
});

test("置信度：每个已评估标签取 min(人侧, 商品)，单元内等权平均，再按贡献权重合并；商品无行内置信度时按来源口径", () => {
  // 理想人侧 0.9：三个标签 min(0.9, 0.8) = 0.8；排斥人侧 0.7：两个标签 min(0.7, ·) = 0.7
  const r = run({ aspiredConf: 0.9, rejectedConf: 0.7 });
  assert.equal(unit(r, "aspired").confidence, 0.8);
  assert.equal(unit(r, "rejected").confidence, 0.7);
  assert.equal(r.dimensionResult.confidence, Math.round(((0.7 * 0.8 + 0.2 * 0.7) / 0.9) * 1000) / 1000);
  const s = run({ rows: ITEM_000002.map(x => ({ ...x, confidence: null, sourceMethod: "stylist" })) });
  assert.equal(unit(s, "aspired").evaluated[0].item_confidence_source, "field_source");
  assert.equal(unit(s, "aspired").evaluated[0].item_confidence, 0.95);
});

test("人侧无变更记录按兜底时在 detail 标记", () => {
  const r = run({ aspiredSrc: "no_record_fallback" });
  assert.deepEqual(r.detail.human_confidence_fallback_units, ["aspired"]);
});

test("理想与排斥都没回答 → no_relevant_assessments；排斥 [] 且理想没回答 → 同样不计算（最喜欢也为空）", () => {
  assert.equal(run({ aspired: null, rejected: null, favorite: null }).detail.skip_reason, "no_relevant_assessments");
  const r = run({ aspired: null, rejected: "[]", favorite: null });
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.detail.expected_weight, 0.7);
});

test("原因码只输出 matching_reason_codes 中方向一致的码；文案与第七节一致且不表达禁止", () => {
  const r = run({ reasonDir: new Map([["PF_ASPIRED_ECHO", "warning"]]) });
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, []);
  assert.deepEqual(PREFERENCE_FIT_REASONS.map(x => [x.code, x.direction, x.meaning]), [
    ["PF_ASPIRED_ECHO", "strength", "这件单品呼应了你希望呈现的形象"],
    ["PF_FAVORITE_ECHO", "strength", "这件单品呼应了你标记为最喜欢的形象"],
    ["PF_REJECTED_CONFLICT", "warning", "这件单品包含你明确不喜欢的形象特征"],
  ]);
  for (const x of PREFERENCE_FIT_REASONS) assert.ok(!/不要|禁止|不能|避免|不适合/.test(x.meaning), x.code);
});

test("三项资格恒为 true；接入汇总层时状态为 valid", () => {
  const r = run();
  assert.deepEqual(r.dimensionResult.eligibility, { purchase: true, recommendation: true, styling: true });
  const out = aggregate({ dimensions: { preference_fit: toInput(r) }, scenario: null, priority: null, profile_version: 14 });
  assert.equal(out.dimensions.preference_fit!.state, "valid");
  assert.equal(out.purchase_eligibility, true);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); process.exitCode = 1; }
}
console.log(`\nmatching-preference: ${passed}/${tests.length} 通过`);
