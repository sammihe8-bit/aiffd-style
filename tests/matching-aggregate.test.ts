// 运行：npm run test:matching
// 离线测试 matching-aggregate.ts，覆盖 ③C 第十三节验收用例。
import assert from "node:assert/strict";
import {
  aggregate, parsePriority, selectForDisplay, DimensionInput, Dimension,
  DIMENSIONS, SCENARIOS, SCENARIO_ADJUSTMENT_PCT, DEFAULT_WEIGHT_PCT,
} from "../api/routes/matching-aggregate";
import { EngineNumericError } from "../api/routes/matching-core";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const dim = (score: number | null, dataCov: number, p: Partial<DimensionInput> = {}): DimensionInput => ({
  score, data_coverage: dataCov, rule_coverage: 0.8, confidence: 0.8,
  eligibility: { purchase: true, recommendation: true, styling: true },
  strengths: [], warnings: [], unit_validation_error_count: 0,
  engine_version: "matching_v1.0", rule_versions: ["v1.1"], ...p,
});
const run = (dimensions: Partial<Record<Dimension, DimensionInput>>, extra: object = {}) =>
  aggregate({ dimensions, profile_version: 7, ...extra });

const noNaN = (r: any) => {
  for (const k of ["match_score", "dimension_coverage", "data_coverage", "rule_coverage", "confidence"]) {
    const v = r[k];
    assert.ok(v === null || Number.isFinite(v), `${k} 不应为 NaN/Infinity，实际 ${v}`);
  }
  for (const d of DIMENSIONS) assert.ok(Number.isFinite(r.weights_used[d]), `weights_used.${d}`);
};

// ── 配置本身 ─────────────────────────────────────────────────────
test("默认权重合计 100", () => {
  assert.equal(Object.values(DEFAULT_WEIGHT_PCT).reduce((a, b) => a + b, 0), 100);
});

test("六个场景的七维调整量全部为 0，向量和为 0", () => {
  assert.deepEqual([...SCENARIOS], ["work", "social", "travel", "casual", "formal", "other"]);
  for (const s of SCENARIOS) {
    for (const d of DIMENSIONS) assert.equal(SCENARIO_ADJUSTMENT_PCT[s][d], 0, `${s}.${d}`);
    assert.equal(DIMENSIONS.reduce((sum, d) => sum + SCENARIO_ADJUSTMENT_PCT[s][d], 0), 0);
  }
});

// ── ③C 第十二节示例 ───────────────────────────────────────────────
test("③C 示例：Body/Style/Color = 80/70/90，coverage 1/0.5/1 → 82.00", () => {
  const r = run({ body_fit: dim(80, 1), style_fit: dim(70, 0.5), color_fit: dim(90, 1) });
  assert.equal(r.overall_status, "ok");
  assert.equal(r.dimension_coverage, 0.6);
  assert.equal(r.weights_used.body_fit, 0.4);
  assert.equal(r.weights_used.style_fit, 0.2);
  assert.equal(r.weights_used.color_fit, 0.4);
  assert.equal(r.match_score, 82);
  assert.equal(r.score_band!.band, "high_match");
  assert.equal(r.data_coverage, 0.5);
  assert.equal(r.rule_coverage, 0.8);
  assert.equal(r.confidence, 0.8);
  assert.equal(r.dimensions.face_fit, null);
  assert.equal(r.weights_used.face_fit, 0);
  noNaN(r);
});

// ── 门槛（③C 第四节表格）────────────────────────────────────────
test("Face + Preference + Scenario + Budget：4 维但只覆盖 0.40 → insufficient", () => {
  const r = run({ face_fit: dim(80, 1), preference_fit: dim(80, 1), scenario_fit: dim(80, 1), budget_fit: dim(80, 1) });
  assert.equal(r.dimension_coverage, 0.4);
  assert.equal(r.overall_status, "insufficient_coverage");
  assert.equal(r.match_score, null);
  assert.equal(r.score_band, null);
});

test("Body + Style + Preference：0.55 → 可计算", () => {
  const r = run({ body_fit: dim(80, 1), style_fit: dim(80, 1), preference_fit: dim(80, 1) });
  assert.equal(r.dimension_coverage, 0.55);
  assert.equal(r.overall_status, "ok");
  assert.equal(r.match_score, 80);
});

test("Body + Color：2 维 0.40 → insufficient", () => {
  const r = run({ body_fit: dim(80, 1), color_fit: dim(80, 1) });
  assert.equal(r.overall_status, "insufficient_coverage");
});

test("恰好 50%：Body + Face + Preference + Budget（20+10+15+5）→ 可计算，无浮点误差", () => {
  const r = run({ body_fit: dim(80, 1), face_fit: dim(80, 1), preference_fit: dim(80, 1), budget_fit: dim(80, 1) });
  assert.equal(r.dimension_coverage, 0.5);
  assert.equal(r.overall_status, "ok");
});

test("仅 Body Fit（当前线上状态）：0.20，weights_used.body_fit = 1，总分与 band 为 null", () => {
  const r = run({ body_fit: dim(78.33, 0.6, { rule_coverage: 0.611 }) });
  assert.equal(r.overall_status, "insufficient_coverage");
  assert.equal(r.dimension_coverage, 0.2);
  assert.equal(r.weights_used.body_fit, 1);
  assert.equal(r.match_score, null);
  assert.equal(r.score_band, null);
  assert.equal(r.confidence, 0.8);            // 不足时仍可汇总 confidence 供诊断
  assert.equal(r.data_coverage, 0.12);        // 0.20 × 0.6
  assert.equal(r.rule_coverage, 0.611);
  assert.equal(r.dimensions.body_fit!.state, "valid");
  assert.deepEqual(r.display.independent, ["INSUFFICIENT_COVERAGE"]);
  noNaN(r);
});

// ── 单维度 0.30 边界 ─────────────────────────────────────────────
test("data_coverage 0.30 有效；0.29 invalid、权重为 0、仍计入总层 data_coverage", () => {
  const ok = run({ body_fit: dim(80, 1), style_fit: dim(80, 1), color_fit: dim(80, 0.3) });
  assert.equal(ok.dimensions.color_fit!.state, "valid");
  assert.equal(ok.overall_status, "ok");

  const bad = run({ body_fit: dim(80, 1), style_fit: dim(80, 1), color_fit: dim(20, 0.29) });
  assert.equal(bad.dimensions.color_fit!.state, "invalid");
  assert.equal(bad.weights_used.color_fit, 0);
  assert.equal(bad.overall_status, "insufficient_coverage");
  assert.equal(bad.data_coverage, round3(0.2 + 0.2 + 0.2 * 0.29));
});

test("未四舍五入比较：0.2999 → invalid（不会被四舍五入成 0.30）", () => {
  const r = run({ body_fit: dim(80, 0.2999) });
  assert.equal(r.dimensions.body_fit!.state, "invalid");
});

test("维度没有可执行单元（score null、coverage 0）→ invalid，不当作 0 分", () => {
  const r = run({ body_fit: dim(null, 0, { rule_coverage: null, confidence: null }), style_fit: dim(80, 1), color_fit: dim(80, 1) });
  assert.equal(r.dimensions.body_fit!.state, "invalid");
  assert.equal(r.overall_status, "insufficient_coverage");
  noNaN(r);
});

test("七维全部缺失：weights_used 全为 0，总层指标为 0 / null，无 NaN", () => {
  const r = run({});
  assert.equal(r.data_coverage, 0);
  assert.equal(r.rule_coverage, null);
  assert.equal(r.confidence, null);
  for (const d of DIMENSIONS) assert.equal(r.weights_used[d], 0);
  noNaN(r);
});

// ── 优先级 ──────────────────────────────────────────────────────
test("Priority high +5：只加所选维度，改变权重但不改变覆盖率门槛", () => {
  const base = run({ body_fit: dim(100, 1), style_fit: dim(50, 1), color_fit: dim(50, 1) });
  const pri = run({ body_fit: dim(100, 1), style_fit: dim(50, 1), color_fit: dim(50, 1) }, { priority: { dimension: "body_fit", level: "high" } });
  assert.equal(base.match_score, round2((20 * 100 + 20 * 50 + 20 * 50) / 60));
  assert.equal(pri.match_score, round2((25 * 100 + 20 * 50 + 20 * 50) / 65));
  assert.equal(pri.dimension_coverage, base.dimension_coverage);
});

test("Priority 不能把 invalid 或缺失维度变有效", () => {
  const r = run({ body_fit: dim(80, 1), color_fit: dim(80, 1) }, { priority: { dimension: "style_fit", level: "high" } });
  assert.equal(r.overall_status, "insufficient_coverage");
  assert.equal(r.weights_used.style_fit, 0);
});

test("parsePriority：多维度拒绝，非法值拒绝，空值放行", () => {
  assert.equal(parsePriority(undefined).ok, true);
  assert.equal(parsePriority([]).ok, true);
  assert.equal(parsePriority({ dimension: "body_fit", level: "low" }).ok, true);
  assert.equal(parsePriority([{ dimension: "body_fit", level: "low" }]).ok, true);
  assert.equal(parsePriority([{ dimension: "body_fit", level: "low" }, { dimension: "style_fit", level: "low" }]).ok, false);
  assert.equal(parsePriority({ dimension: "hair_fit", level: "low" }).ok, false);
  assert.equal(parsePriority({ dimension: "body_fit", level: "max" }).ok, false);
});

// ── 资格 ────────────────────────────────────────────────────────
test("资格合并所有已计算维度（含 invalid），与覆盖率门槛独立", () => {
  const r = run({
    body_fit: dim(80, 1, { eligibility: { purchase: false, recommendation: true, styling: true } }),
    budget_fit: dim(null, 0, { eligibility: { purchase: true, recommendation: false, styling: true } }),
  });
  assert.equal(r.purchase_eligibility, false);
  assert.equal(r.recommendation_eligibility, false);
  assert.equal(r.styling_eligibility, true);
  assert.deepEqual(r.display.independent, ["INSUFFICIENT_COVERAGE", "PURCHASE_INELIGIBLE", "RECOMMENDATION_INELIGIBLE"]);
});

// ── 解释 ────────────────────────────────────────────────────────
test("③C 例：覆盖不足 + 购买关闭时，warnings 仍可展示两条规则冲突", () => {
  const r = run({
    body_fit: dim(60, 1, { warnings: ["W_BODY_1", "W_BODY_2"], eligibility: { purchase: false, recommendation: true, styling: true } }),
  });
  assert.deepEqual(r.display.warnings.map(w => w.code), ["W_BODY_1", "W_BODY_2"]);
  assert.ok(r.diagnostics.some(d => d.code === "INSUFFICIENT_COVERAGE"));
  assert.ok(r.diagnostics.some(d => d.code === "PURCHASE_INELIGIBLE"));
});

test("校验异常排在规则冲突之前；最多 2 条 warnings、3 条 strengths；去重", () => {
  const r = run({
    body_fit: dim(80, 1, { strengths: ["S1", "S2"], warnings: ["W1"], unit_validation_error_count: 2 }),
    style_fit: dim(80, 1, { strengths: ["S2", "S3", "S4"], warnings: ["W2"] }),
    color_fit: dim(80, 1),
  });
  assert.deepEqual(r.display.warnings.map(w => w.code), ["UNIT_VALIDATION_ERROR", "W1"]);
  assert.deepEqual(r.display.strengths.map(s => s.code), ["S1", "S2", "S3"]);
  // 完整证据不删除
  assert.equal(r.warnings.length, 2);
  assert.equal(r.strengths.length, 5);
  const uve = r.diagnostics.find(d => d.code === "UNIT_VALIDATION_ERROR")!;
  assert.equal(uve.source, "system");
  assert.equal((uve as any).dimension, "body_fit");
  assert.equal((uve as any).count, 2);
});

test("规则原因码与系统诊断码来源分开标记", () => {
  const r = run({ body_fit: dim(80, 1, { strengths: ["BODY_VOLUME_BALANCED"] }) });
  assert.equal(r.strengths[0].source, "rule");
  assert.ok(r.diagnostics.every(d => d.source === "system"));
});

test("adjustments 固定为空数组", () => {
  assert.deepEqual(run({}).adjustments, []);
});

// ── 分数等级 ────────────────────────────────────────────────────
test("89.60 → high_match（按两位小数判断，不按显示取整）", () => {
  const r = run({ body_fit: dim(89.6, 1), style_fit: dim(89.6, 1), color_fit: dim(89.6, 1) });
  assert.equal(r.match_score, 89.6);
  assert.equal(r.score_band!.band, "high_match");
});

test("selectForDisplay：只有独立诊断时 warnings 为空", () => {
  const d = selectForDisplay([], [], [{ source: "system", code: "INSUFFICIENT_COVERAGE", scope: "overall", display: "independent" }]);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(d.independent, ["INSUFFICIENT_COVERAGE"]);
});

// ── 03D P0：priority 解析安全 ────────────────────────────────────
test("priority：[null]、[undefined]、嵌套数组、字符串、数字均安全拒绝，不抛异常", () => {
  for (const raw of [[null], [undefined], [[{ dimension: "body_fit", level: "high" }]], "high", 5, true]) {
    const r = parsePriority(raw as any);
    assert.equal(r.ok, false, JSON.stringify(raw));
  }
});

test("priority：toString / __proto__ / constructor / hasOwnProperty 等继承属性一律拒绝", () => {
  for (const level of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) {
    assert.equal(parsePriority({ dimension: "body_fit", level }).ok, false, `level=${level}`);
    assert.equal(parsePriority({ dimension: level, level: "high" }).ok, false, `dimension=${level}`);
  }
  const proto = JSON.parse('{"__proto__": {"dimension": "body_fit", "level": "high"}}');
  assert.equal(parsePriority(proto).ok, false, "原型链上的字段不算");
});

test("priority：合法对象、单元素数组、空数组照常", () => {
  assert.deepEqual(parsePriority({ dimension: "style_fit", level: "medium" }), { ok: true, value: { dimension: "style_fit", level: "medium" } });
  assert.deepEqual(parsePriority([{ dimension: "style_fit", level: "low" }]), { ok: true, value: { dimension: "style_fit", level: "low" } });
  assert.deepEqual(parsePriority([]), { ok: true, value: null });
});

test("aggregate 直接收到非法 priority / scenario → 抛错，不会算出假分数", () => {
  const dims = { body_fit: dim(80, 1), style_fit: dim(80, 1), color_fit: dim(80, 1) };
  assert.throws(() => run(dims, { priority: { dimension: "body_fit", level: "toString" } }), EngineNumericError);
  assert.throws(() => run(dims, { scenario: "leisure" }), EngineNumericError);
});

// ── 03D P0 / P1：汇总层数值防护 ──────────────────────────────────
test("维度输入含 NaN / 越界 → 抛 EngineNumericError", () => {
  assert.throws(() => run({ body_fit: dim(NaN, 1) }), EngineNumericError);
  assert.throws(() => run({ body_fit: dim(120, 1) }), EngineNumericError);
  assert.throws(() => run({ body_fit: dim(80, 1.2) }), EngineNumericError);
  assert.throws(() => run({ body_fit: dim(80, Infinity) }), EngineNumericError);
});

test("有分数却缺 confidence、有数据却缺 rule_coverage → 抛错，不静默重归一化", () => {
  assert.throws(() => run({ body_fit: dim(80, 1, { confidence: null }) }), EngineNumericError);
  assert.throws(() => run({ body_fit: dim(80, 1, { rule_coverage: null }) }), EngineNumericError);
});

test("T06：原始 coverage 0.2996 不会被当成 0.30", () => {
  const r = run({ body_fit: dim(80, 1), style_fit: dim(80, 1), color_fit: dim(80, 0.2996) });
  assert.equal(r.dimensions.color_fit!.state, "invalid");
  assert.equal(r.overall_status, "insufficient_coverage");
});

function round2(n: number) { return Math.round(n * 100) / 100; }
function round3(n: number) { return Math.round(n * 1000) / 1000; }

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
console.log(`\n${passed}/${tests.length} 通过`);
if (passed !== tests.length) process.exit(1);
