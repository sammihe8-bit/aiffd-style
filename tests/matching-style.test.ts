// 运行：npm run test:matching（或 npx tsx tests/matching-style.test.ts）
// 离线测试 matching-style.ts，不连数据库。覆盖 03A Part C Style Fit 的计分公式、覆盖率、置信度、
// 原因码、缺失与校验处理、汇总层接入，以及商品侧写入校验。
// 测试数据取自 2026-10-03 线上查询：AIFFD_PROFILE_000001 × AIFFD_ITEM_000002。
import assert from "node:assert/strict";
import {
  computeStyleFit, validateItemStyleScores, HumanStyleRow, ItemStyleRow, STYLE_FIT_REASONS,
} from "../api/routes/matching-style";
import { aggregate, DimensionInput } from "../api/routes/matching-aggregate";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// 人侧 13 型（数据库 decimal 返回字符串，这里也用字符串）
const HUMAN: [string, string][] = [
  ["C", "0.487"], ["SN", "0.447"], ["SC", "0.288"], ["N", "0.224"], ["FN", "0.224"], ["DC", "0.209"], ["G", "0.206"],
  ["TR", "0.124"], ["SD", "0.058"], ["D", "0.058"], ["FG", "0.000"], ["SG", "0.000"], ["R", "0.000"],
];
const human = (): HumanStyleRow[] => HUMAN.map(([c, p]) => ({
  styleCode: c, probability: p, isPrimary: c === "C", isSecondary: c === "SN", engineVersion: "style_engine_v2.1",
}));

const item = (over: Partial<Record<string, Partial<ItemStyleRow>>> = {}): ItemStyleRow[] => [
  { styleCode: "C", score: "0.72", confidence: "0.80", sourceMethod: "rule_engine", verifiedStatus: "unverified", isPrimary: true, ...over.C },
  { styleCode: "SC", score: "0.45", confidence: "0.70", sourceMethod: "rule_engine", verifiedStatus: "unverified", ...over.SC },
  { styleCode: "N", score: "0.30", confidence: null, sourceMethod: "rule_engine", verifiedStatus: "unverified", ...over.N },
];

const allReasons = () => new Map<string, string>(STYLE_FIT_REASONS.map(r => [r.code, r.direction]));
const run = (h: HumanStyleRow[], i: ItemStyleRow[], opts: { reasonDir?: Map<string, string>; gamma?: number } = {}) =>
  computeStyleFit({ humanRows: h, itemRows: i, humanConfidence: 0.8, reasonDir: opts.reasonDir ?? allReasons(), gamma: opts.gamma });

// ── 计分基准 ──────────────────────────────────────────────────────
test("测试账号 × ITEM_000002：54.80 / 0.430 / 1 / 0.749", () => {
  const r = run(human(), item());
  assert.equal(r.dimensionResult.score, 54.8);
  assert.equal(r.dimensionResult.data_coverage, 0.43);
  assert.equal(r.dimensionResult.rule_coverage, 1);
  assert.equal(r.dimensionResult.confidence, 0.749);
  assert.equal(r.dimensionResult.dimension, "style_fit");
  assert.equal(r.detail.skip_reason, null);
  assert.equal(r.dimensionResult.rules_applied, 3);
  assert.equal(r.dimensionResult.units_skipped, 10);
  assert.ok(r.detail.unscored_style_codes.includes("SN"));
  assert.ok(Math.abs(r.exact.data_coverage - 0.999 / 2.325) < 1e-9);
});

test("原因码：只有 SF_PRIMARY_ECHO", () => {
  const r = run(human(), item());
  assert.deepEqual(r.dimensionResult.strengths, ["SF_PRIMARY_ECHO"]);
  assert.deepEqual(r.dimensionResult.warnings, []);
});

test("N 改为 manual_operator 后 confidence = 0.771", () => {
  const r = run(human(), item({ N: { sourceMethod: "manual_operator" } }));
  assert.equal(r.dimensionResult.confidence, 0.771);
  assert.equal(r.dimensionResult.score, 54.8);
});

test("γ = 2：60.26 / 0.508", () => {
  const r = run(human(), item(), { gamma: 2 });
  assert.equal(r.dimensionResult.score, 60.26);
  assert.equal(r.dimensionResult.data_coverage, 0.508);
});

test("rejected 行视为缺失：K = C、SC → 61.97 / 0.333", () => {
  const r = run(human(), item({ N: { verifiedStatus: "rejected" } }));
  assert.equal(r.dimensionResult.score, 61.97);
  assert.equal(r.dimensionResult.data_coverage, 0.333);
  assert.equal(r.detail.item_rows_rejected, 1);
});

// ── 缺失与校验 ───────────────────────────────────────────────────
test("商品无风格分（ITEM_000001）：score null，data_coverage 0", () => {
  const r = run(human(), []);
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.dimensionResult.data_coverage, 0);
  assert.equal(r.dimensionResult.rule_coverage, null);
  assert.equal(r.dimensionResult.confidence, null);
  assert.equal(r.detail.skip_reason, "item_scores_missing");
  assert.deepEqual(r.dimensionResult.strengths, []);
});

test("人侧不足 13 行：不计算，不合成分布", () => {
  const r = run(human().slice(0, 12), item());
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.detail.skip_reason, "human_scores_incomplete");
});

test("人侧只有主/次型（0 行）：不计算", () => {
  const r = run([], item());
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.detail.skip_reason, "human_scores_incomplete");
});

test("人侧同型重复、非法代码、越界：不计算", () => {
  const dup = human(); dup[12] = { ...dup[12], styleCode: "C" };
  assert.equal(run(dup, item()).detail.skip_reason, "human_scores_incomplete");
  const proto = human(); proto[12] = { ...proto[12], styleCode: "__proto__" };
  assert.equal(run(proto, item()).detail.skip_reason, "human_scores_incomplete");
  const bad = human(); bad[0] = { ...bad[0], probability: "1.5" };
  assert.equal(run(bad, item()).detail.skip_reason, "human_scores_incomplete");
});

test("商品同型重复：validation_error，整维不计算", () => {
  const rows = [...item(), { styleCode: "C", score: "0.10", confidence: null, sourceMethod: "stylist", verifiedStatus: "unverified" }];
  const r = run(human(), rows);
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.detail.skip_reason, "item_scores_invalid");
  assert.equal(r.detail.unit_validation_errors.length, 1);
  assert.equal(r.detail.unit_validation_errors[0].reason, "duplicate_style_code");
});

test("商品非法代码（toString）和越界置信度：validation_error", () => {
  const r1 = run(human(), [...item(), { styleCode: "toString", score: "0.5", confidence: null, sourceMethod: "stylist", verifiedStatus: "unverified" }]);
  assert.equal(r1.detail.skip_reason, "item_scores_invalid");
  const r2 = run(human(), item({ SC: { confidence: "9.99" } }));
  assert.equal(r2.detail.skip_reason, "item_scores_invalid");
});

test("商品只给人侧概率为 0 的型：score null", () => {
  const r = run(human(), [{ styleCode: "FG", score: "0.90", confidence: null, sourceMethod: "stylist", verifiedStatus: "unverified" }]);
  assert.equal(r.dimensionResult.score, null);
  assert.equal(r.dimensionResult.data_coverage, 0);
  assert.equal(r.detail.skip_reason, "no_weight_on_scored_styles");
});

test("只给弱项高分：score 高但 data_coverage < 0.30", () => {
  const r = run(human(), [{ styleCode: "D", score: "0.95", confidence: null, sourceMethod: "stylist", verifiedStatus: "unverified", isPrimary: true }]);
  assert.equal(r.dimensionResult.score, 95);
  assert.ok(r.dimensionResult.data_coverage < 0.3);
  assert.deepEqual(r.dimensionResult.warnings, ["SF_ITEM_STYLE_FOREIGN"]);
});

// ── 原因码 ───────────────────────────────────────────────────────
test("SF_SECONDARY_ECHO：次型 SN ≥ 0.60", () => {
  const r = run(human(), [...item(), { styleCode: "SN", score: "0.70", confidence: null, sourceMethod: "stylist", verifiedStatus: "unverified" }]);
  assert.deepEqual(r.dimensionResult.strengths.sort(), ["SF_PRIMARY_ECHO", "SF_SECONDARY_ECHO"]);
});

test("SF_PRIMARY_WEAK：主型 C ≤ 0.30", () => {
  const r = run(human(), item({ C: { score: "0.25", isPrimary: false }, SC: { isPrimary: true } }));
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, ["SF_PRIMARY_WEAK"]);
});

test("阈值边界：0.60 触发 ECHO，0.30 触发 WEAK", () => {
  assert.deepEqual(run(human(), item({ C: { score: "0.60" } })).dimensionResult.strengths, ["SF_PRIMARY_ECHO"]);
  assert.deepEqual(run(human(), item({ C: { score: "0.59" } })).dimensionResult.strengths, []);
  assert.deepEqual(run(human(), item({ C: { score: "0.30", isPrimary: false }, SC: { isPrimary: true } })).dimensionResult.warnings, ["SF_PRIMARY_WEAK"]);
});

test("原因码表里没有的码不输出；方向不一致也不输出", () => {
  assert.deepEqual(run(human(), item(), { reasonDir: new Map() }).dimensionResult.strengths, []);
  const wrong = new Map([["SF_PRIMARY_ECHO", "warning"]]);
  const r = run(human(), item(), { reasonDir: wrong });
  assert.deepEqual(r.dimensionResult.strengths, []);
  assert.deepEqual(r.dimensionResult.warnings, []);
});

// ── 汇总层接入 ───────────────────────────────────────────────────
test("汇总：body + face + style 三维有效 → ok，约 65.82", () => {
  const s = run(human(), item());
  const dim = (score: number, dc: number): DimensionInput => ({
    score, data_coverage: dc, rule_coverage: 1, confidence: 0.8,
    eligibility: { purchase: true, recommendation: true, styling: true },
    strengths: [], warnings: [], unit_validation_error_count: 0, engine_version: "matching_v1.0", rule_versions: ["v1.0"],
  });
  const out = aggregate({
    dimensions: {
      body_fit: dim(78.33, 0.6),
      face_fit: dim(60.28, 1),
      style_fit: {
        score: s.dimensionResult.score, data_coverage: s.exact.data_coverage, rule_coverage: s.dimensionResult.rule_coverage,
        confidence: s.dimensionResult.confidence, eligibility: s.dimensionResult.eligibility,
        strengths: s.dimensionResult.strengths, warnings: s.dimensionResult.warnings,
        unit_validation_error_count: s.detail.unit_validation_errors.length, engine_version: "matching_v1.0",
        rule_versions: s.dimensionResult.rule_versions,
      },
    },
    scenario: null, priority: null, profile_version: 10,
  });
  assert.equal(out.overall_status, "ok");
  assert.equal(out.valid_dimensions, 3);
  assert.ok(out.match_score !== null && Math.abs(out.match_score - 65.82) <= 0.01, `match_score = ${out.match_score}`);
});

// ── 商品侧写入校验 ───────────────────────────────────────────────
const ok = (x: Parameters<typeof validateItemStyleScores>[0]) => assert.deepEqual(validateItemStyleScores(x), []);
const bad = (x: Parameters<typeof validateItemStyleScores>[0], part: string) => {
  const p = validateItemStyleScores(x);
  assert.ok(p.some(m => m.includes(part)), `期望包含「${part}」，实际 ${JSON.stringify(p)}`);
};

test("写入校验：ITEM_000002 现有数据合法；部分型合法", () => {
  ok([{ styleCode: "C", score: 0.72, isPrimary: true }, { styleCode: "SC", score: 0.45, isSecondary: true }, { styleCode: "N", score: 0.3 }]);
  ok([{ styleCode: "D", score: 0.5 }]);
});

test("写入校验：空、重复、非法代码、越界", () => {
  bad([], "至少");
  bad([{ styleCode: "C", score: 0.5 }, { styleCode: "C", score: 0.4 }], "重复");
  bad([{ styleCode: "toString", score: 0.5 }], "非法风格代码");
  bad([{ styleCode: "C", score: 1.2 }], "0~1");
  bad([{ styleCode: "C", score: NaN }], "0~1");
});

test("写入校验：主型/次型规则", () => {
  bad([{ styleCode: "C", score: 0.5, isPrimary: true }, { styleCode: "SC", score: 0.6 }], "主型 C 不是最高分");
  bad([{ styleCode: "C", score: 0.7, isPrimary: true }, { styleCode: "SC", score: 0.6, isPrimary: true }], "主型最多 1 个");
  bad([{ styleCode: "C", score: 0.7 }, { styleCode: "SC", score: 0.6, isSecondary: true }], "必须同时标记主型");
  bad([{ styleCode: "C", score: 0.7, isPrimary: true, isSecondary: true }], "同一项");
  bad([{ styleCode: "C", score: 0.7, isPrimary: true }, { styleCode: "SC", score: 0.4, isSecondary: true }, { styleCode: "N", score: 0.5 }], "次型 SC 不是其余最高分");
  ok([{ styleCode: "C", score: 0.7, isPrimary: true }, { styleCode: "SC", score: 0.7, isSecondary: true }]);   // 并列允许
  ok([{ styleCode: "C", score: 0.704, isPrimary: true }, { styleCode: "SC", score: 0.7 }]);                    // 按 2 位小数比较
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); process.exitCode = 1; }
}
console.log(`\nmatching-style: ${passed}/${tests.length} 通过`);
