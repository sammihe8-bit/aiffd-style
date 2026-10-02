// 运行：npm run test:matching
// 离线测试 matching-core.ts，不连数据库。覆盖 ③C 第十三节两项前置修复的验收用例，
// 以及 Face Fit V1.0（2026-10-01）的字段注册、规则数据、品类门控和测试账号预期值。
import assert from "node:assert/strict";
import { MatchingRule } from "../db/schema";
import {
  computeDimension, validateRule, validateRuleSet, readHumanValue, HUMAN_FIELDS, ITEM_FIELDS, EngineNumericError,
  channelAppliesTo, CHANNEL_CATEGORY_SCOPE,
} from "../api/routes/matching-core";
import { aggregate } from "../api/routes/matching-aggregate";
import { faceFitRules, FACE_FIT_REASONS } from "./face-fit-rules";

let passed = 0;
const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

let seq = 0;
function rule(p: Partial<MatchingRule>): MatchingRule {
  seq++;
  return {
    id: seq, ruleId: `T_${String(seq).padStart(3, "0")}`, channel: "body_fit",
    subDimension: "waist", humanField: "waist_type", humanValue: ["细"],
    itemField: "waist_structure", itemValue: ["*"],
    matchType: "positive", strength: "high", ruleWeight: "1.5",
    isActive: true, constraintScope: null, scoreDelta: null,
    reasonCode: null, ruleVersion: "v1.1", note: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...p,
  } as MatchingRule;
}

// 取一个合法的商品侧 waist_structure / visual_volume 值和人侧 bone_scale 值
const { fashionItems, humanStyleProfiles } = require("../db/schema");
const WS = fashionItems.waistStructure.enumValues as string[];
const VV = fashionItems.visualVolume.enumValues as string[];
const BS = humanStyleProfiles.boneScale.enumValues as string[];

// 基础规则集：两个子维度，三个计分单元
const baseRules = () => [
  rule({ subDimension: "waist", humanField: "waist_type", humanValue: ["细"], itemField: "waist_structure", itemValue: [WS[0]], matchType: "positive", strength: "high", ruleWeight: "1.5" }),
  rule({ subDimension: "waist", humanField: "waist_type", humanValue: ["宽"], itemField: "waist_structure", itemValue: [WS[0]], matchType: "penalty", strength: "medium", ruleWeight: "1.5" }),
  rule({ subDimension: "volume", humanField: "bone_scale", humanValue: [BS[0]], itemField: "visual_volume", itemValue: [VV[0]], matchType: "positive", strength: "medium", ruleWeight: "1.5" }),
];

async function run(rules: MatchingRule[], waistType: unknown, opts: { itemWS?: string | null; boneScale?: string | null } = {}) {
  const logs: unknown[] = [];
  const out = await computeDimension({
    channel: "body_fit", rules, reasonDir: new Map(),
    profile: { waistType, boneScale: opts.boneScale === undefined ? BS[0] : opts.boneScale },
    item: { waistStructure: opts.itemWS === undefined ? WS[0] : opts.itemWS, visualVolume: VV[0] },
    material: null,
    humanConfidence: async () => 0.8,
    itemConfidence: async () => 0.8,
    log: (m, p) => logs.push([m, p]),
  });
  return { ...out, logs };
}

const noNaN = (d: any) => {
  for (const k of ["score", "data_coverage", "rule_coverage", "confidence"]) {
    const v = d[k];
    assert.ok(v === null || Number.isFinite(v), `${k} 不应为 NaN/Infinity，实际 ${v}`);
  }
};
const statusOf = (detail: any, field: string) => detail.units.filter((u: any) => u.human_field === field).map((u: any) => u.status);

// ── 前置修复二：waist_type 单选校验 ──────────────────────────────
test("waist_type 单个合法值（JSON 字符串存储）正常参与", async () => {
  const { dimensionResult: d, detail } = await run(baseRules(), '["细"]');
  assert.deepEqual(statusOf(detail, "waist_type"), ["explicit_rule"]);
  // waist: 1.0 × 1.5，volume: 0.8 × 1.5 → (1.5 + 1.2) / 3 = 90
  assert.equal(d.score, 90);
  assert.equal(d.data_coverage, 1);
  noNaN(d);
});

test("waist_type 驱动直接返回数组也能读取", async () => {
  const { detail } = await run(baseRules(), ["细"]);
  assert.deepEqual(statusOf(detail, "waist_type"), ["explicit_rule"]);
});

test("waist_type 多个合法值 → validation_error，不取首值", async () => {
  const { dimensionResult: d, detail, logs } = await run(baseRules(), '["细","匀"]');
  assert.deepEqual(statusOf(detail, "waist_type"), ["validation_error"]);
  assert.equal(detail.unit_validation_errors[0].reason, "single_select_multiple_values");
  assert.equal(logs.length, 1, "应写日志");
  // 只剩 volume 单元有效：score = 80，data_coverage = 1.5 / 3
  assert.equal(d.score, 80);
  assert.equal(d.data_coverage, 0.5);
  noNaN(d);
});

test("waist_type 非法值 → validation_error，不静默过滤", async () => {
  for (const v of ['["胖"]', '["细","胖"]', "胖"]) {
    const { detail } = await run(baseRules(), v);
    assert.deepEqual(statusOf(detail, "waist_type"), ["validation_error"], `输入 ${v}`);
  }
  const { detail } = await run(baseRules(), '["胖"]');
  assert.equal(detail.unit_validation_errors[0].reason, "illegal_value");
});

test("waist_type 空值 / 空数组 / 不确定 → not_applicable", async () => {
  for (const v of [null, "", "[]", '["不确定"]', "不确定"]) {
    const { detail } = await run(baseRules(), v);
    assert.deepEqual(statusOf(detail, "waist_type"), ["not_applicable"], `输入 ${JSON.stringify(v)}`);
    assert.equal(detail.unit_validation_errors.length, 0);
  }
});

test("不确定 + 其他值 属于多值 → validation_error", async () => {
  const { detail } = await run(baseRules(), '["不确定","细"]');
  assert.deepEqual(statusOf(detail, "waist_type"), ["validation_error"]);
});

test("readHumanValue：数据库 enum 字段保持原逻辑", () => {
  assert.deepEqual(readHumanValue(HUMAN_FIELDS.bone_scale, BS[0]), { kind: "ok", values: [BS[0]] });
  assert.deepEqual(readHumanValue(HUMAN_FIELDS.bone_scale, "不确定"), { kind: "missing" });
});

test("原有校验保留：同一单元命中多条规则 → validation_error", async () => {
  const rules = [...baseRules(), rule({ subDimension: "waist", humanField: "waist_type", humanValue: ["细"], itemField: "waist_structure", itemValue: ["*"], matchType: "neutral", strength: null, ruleWeight: "1.5" })];
  const { detail } = await run(rules, '["细"]');
  assert.deepEqual(statusOf(detail, "waist_type"), ["validation_error"]);
  assert.equal(detail.unit_validation_errors[0].reason, "multiple_rules_hit");
});

// ── 前置修复一：hard_constraint 从计分中剔除 ────────────────────
const hc = (scope: "purchase" | "recommendation" | "styling" | "all", p: Partial<MatchingRule> = {}) =>
  rule({ matchType: "hard_constraint", strength: null, ruleWeight: null, constraintScope: scope,
    subDimension: "waist", humanField: "waist_type", humanValue: ["细"], itemField: "waist_structure", itemValue: [WS[0]], ...p });

test("普通规则与硬约束共存：分数和覆盖率与没有硬约束时完全一致", async () => {
  const without = await run(baseRules(), '["细"]');
  // 硬约束与普通规则落在同一计分单元，且另开一个只有硬约束的"新单元"
  const withHc = await run([...baseRules(), hc("purchase"), hc("styling", { subDimension: "limb", humanField: "bone_scale", humanValue: [BS[0]], itemField: "visual_volume", itemValue: ["*"] })], '["细"]');
  for (const k of ["score", "data_coverage", "rule_coverage", "confidence", "rules_applied", "default_neutral_units", "units_skipped"] as const) {
    assert.equal((withHc.dimensionResult as any)[k], (without.dimensionResult as any)[k], k);
  }
  assert.equal(withHc.detail.units.length, without.detail.units.length, "硬约束不应新增计分单元");
  noNaN(withHc.dimensionResult);
  assert.deepEqual(withHc.dimensionResult.eligibility, { purchase: false, recommendation: true, styling: false });
});

test("仅有硬约束：score 为 null，无 NaN，资格正常判定", async () => {
  const { dimensionResult: d } = await run([hc("recommendation")], '["细"]');
  assert.equal(d.score, null);
  assert.equal(d.score_band, null);
  assert.equal(d.data_coverage, 0);
  noNaN(d);
  assert.deepEqual(d.eligibility, { purchase: true, recommendation: false, styling: true });
});

test("四种 scope 各自只关闭对应资格；all 关闭三项；多个合并", async () => {
  const cases: [any, object][] = [
    ["purchase", { purchase: false, recommendation: true, styling: true }],
    ["recommendation", { purchase: true, recommendation: false, styling: true }],
    ["styling", { purchase: true, recommendation: true, styling: false }],
    ["all", { purchase: false, recommendation: false, styling: false }],
  ];
  for (const [scope, expected] of cases) {
    const { dimensionResult: d } = await run([...baseRules(), hc(scope)], '["细"]');
    assert.deepEqual(d.eligibility, expected, scope);
  }
  const { dimensionResult: d } = await run([...baseRules(), hc("purchase"), hc("recommendation")], '["细"]');
  assert.deepEqual(d.eligibility, { purchase: false, recommendation: false, styling: true });
  assert.equal(d.constraints_triggered, 2);
});

test("硬约束未命中 → 资格保持 true", async () => {
  const { dimensionResult: d, detail } = await run([...baseRules(), hc("all", { humanValue: ["宽"] })], '["细"]');
  assert.deepEqual(d.eligibility, { purchase: true, recommendation: true, styling: true });
  assert.equal(detail.constraint_results[0].status, "clear");
});

test("硬约束数据缺失 → not_evaluable，不关闭资格", async () => {
  const { dimensionResult: d, detail } = await run([...baseRules(), hc("all")], '["细"]', { itemWS: null });
  assert.deepEqual(d.eligibility, { purchase: true, recommendation: true, styling: true });
  assert.equal(detail.constraint_results[0].status, "not_evaluable");
});

test("硬约束遇到 waist_type 非法输入 → validation_error，不关闭资格", async () => {
  const { dimensionResult: d, detail } = await run([...baseRules(), hc("all")], '["细","匀"]');
  assert.equal(detail.constraint_results[0].status, "validation_error");
  assert.deepEqual(d.eligibility, { purchase: true, recommendation: true, styling: true });
});

// ── 规则校验 ─────────────────────────────────────────────────────
test("硬约束无需 rule_weight，但必须有 constraint_scope", () => {
  assert.deepEqual(validateRule(hc("purchase")), []);
  assert.ok(validateRule(hc("purchase", { constraintScope: null })).some(p => p.includes("constraint_scope")));
  assert.ok(validateRule(rule({ ruleWeight: null })).some(p => p.includes("rule_weight")));
});

test("子维度权重一致性检查忽略硬约束", () => {
  const { errors } = validateRuleSet([...baseRules(), hc("purchase", { ruleWeight: "2.0" })]);
  assert.deepEqual(errors, []);
  const bad = validateRuleSet([...baseRules(), rule({ subDimension: "waist", humanField: "waist_type", humanValue: ["匀"], itemField: "waist_structure", itemValue: [WS[0]], ruleWeight: "2.0" })]);
  assert.ok(bad.errors.some(e => e.problem.includes("rule_weight 不一致")));
});

// ── 03D P0：规则权重 ──────────────────────────────────────────────
test("rule_weight 为 0、负数、非数字、无限大 → 规则非法", () => {
  for (const w of ["0", "-1", "abc", "Infinity", "NaN"]) {
    assert.ok(validateRule(rule({ ruleWeight: w })).some(p => p.includes("rule_weight")), `rule_weight=${w}`);
  }
  assert.deepEqual(validateRule(rule({ ruleWeight: "0.5" })), []);
});

test("同一子维度权重不一致 → 该子维度计分规则整组排除，其他子维度照常", async () => {
  const rules = [...baseRules(), rule({ subDimension: "waist", humanField: "waist_type", humanValue: ["匀"], itemField: "waist_structure", itemValue: [WS[0]], ruleWeight: "2.0" })];
  const { valid, errors } = validateRuleSet(rules);
  assert.ok(valid.every(r => r.subDimension !== "waist"), "waist 子维度应全部排除");
  assert.equal(valid.filter(r => r.subDimension === "volume").length, 1);
  assert.ok(errors.length > 0 && errors.every(e => e.code === "RULE_CONFIGURATION_ERROR"));
  // 排除后只剩 volume：0.8 → 80 分
  const { dimensionResult: d } = await run(valid, '["细"]');
  assert.equal(d.score, 80);
  noNaN(d);
});

test("非法 constraint_scope、空 human_value / item_value / sub_dimension → 规则非法", () => {
  assert.ok(validateRule(hc("purchase", { constraintScope: "checkout" as any })).some(p => p.includes("constraint_scope")));
  assert.ok(validateRule(rule({ humanValue: [] })).some(p => p.includes("human_value 为空")));
  assert.ok(validateRule(rule({ itemValue: [] })).some(p => p.includes("item_value 为空")));
  assert.ok(validateRule(rule({ subDimension: " " })).some(p => p.includes("sub_dimension 为空")));
});

test("RULE_VALIDATION_ERROR 带 code 字段", () => {
  const { errors } = validateRuleSet([rule({ ruleWeight: "0" })]);
  assert.equal(errors[0].code, "RULE_VALIDATION_ERROR");
});

// ── 03D P0：数值防护 ─────────────────────────────────────────────
test("置信度返回 NaN → 抛 EngineNumericError，不返回分数", async () => {
  await assert.rejects(
    computeDimension({
      channel: "body_fit", rules: baseRules(), reasonDir: new Map(),
      profile: { waistType: '["细"]', boneScale: BS[0] }, item: { waistStructure: WS[0], visualVolume: VV[0] }, material: null,
      humanConfidence: async () => NaN, itemConfidence: async () => 0.8, log: () => {},
    }),
    (e: unknown) => e instanceof EngineNumericError && e.code === "ENGINE_NUMERIC_ERROR",
  );
});

// ── 03D P1：日志脱敏 ─────────────────────────────────────────────
test("日志不含用户原始值", async () => {
  const { logs } = await run(baseRules(), '["细","匀"]');
  const text = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  assert.ok(!text.includes("细") && !text.includes("匀"), "日志里不应出现档案原始值");
  assert.ok(text.includes("single_select_multiple_values"));
});

// ── Face Fit V1.0（03A Face Fit 定稿版）────────────────────────────
const FACE_HUMAN = [
  "cheek_contour", "cheekbone_shape", "chin_shape", "nose_shape", "eye_shape", "eye_size",
  "nose_size", "mouth_fullness", "chin_length", "cheek_fullness", "cheekbone_prominence", "nose_projection",
];

// 测试账号 AIFFD_PROFILE_000001 的面部字段（2026-10-01 TiDB 查询结果）
const TEST_FACE = {
  cheekContour: "angular", cheekboneShape: "balanced", chinShape: "square", noseShape: "balanced", eyeShape: "round",
  eyeSize: "small", noseSize: "medium", mouthFullness: "medium", chinLength: "short", cheekFullness: "moderate",
  cheekboneProminence: "prominent", noseProjection: "medium",
};
// 测试商品 AIFFD_ITEM_000002（tops）
const TEST_ITEM = { lineQuality: null as string | null, neckline: "crew", visualVolume: "small", structureLevel: "soft" };
const faceReasonDir = new Map(FACE_FIT_REASONS.map(([c, , d]) => [c, d as string]));

async function runFace(item: Record<string, unknown>, profile: Record<string, unknown> = TEST_FACE) {
  const { valid } = validateRuleSet(faceFitRules());
  return computeDimension({
    channel: "face_fit", rules: valid, reasonDir: faceReasonDir, profile, item, material: null,
    humanConfidence: async () => 0.8, itemConfidence: async () => 0.8, log: () => {},
  });
}

test("Face Fit：12 个人侧字段注册，值域与数据库枚举一致", () => {
  const schemaKeys: Record<string, string> = {
    cheek_contour: "cheekContour", cheekbone_shape: "cheekboneShape", chin_shape: "chinShape", nose_shape: "noseShape",
    eye_shape: "eyeShape", eye_size: "eyeSize", nose_size: "noseSize", mouth_fullness: "mouthFullness",
    chin_length: "chinLength", cheek_fullness: "cheekFullness", cheekbone_prominence: "cheekboneProminence", nose_projection: "noseProjection",
  };
  for (const f of FACE_HUMAN) {
    assert.ok(HUMAN_FIELDS[f], `未注册 ${f}`);
    assert.equal(HUMAN_FIELDS[f].key, schemaKeys[f]);
    assert.deepEqual([...HUMAN_FIELDS[f].values], [...(humanStyleProfiles as any)[schemaKeys[f]].enumValues]);
  }
  assert.ok(!HUMAN_FIELDS.jawline && !HUMAN_FIELDS.face_shape && !HUMAN_FIELDS.face_line, "V1.0 不注册未采集的汇总字段");
});

test("Face Fit：line_quality 注册；neckline 值域去掉 other", () => {
  assert.deepEqual([...ITEM_FIELDS.line_quality.values], [...fashionItems.lineQuality.enumValues]);
  assert.ok(!ITEM_FIELDS.neckline.values.includes("other"));
  assert.equal(ITEM_FIELDS.neckline.values.length, fashionItems.neckline.enumValues.length - 1);
});

test("Face Fit：123 条规则全部合法，12 个计分单元，4 个子维度权重一致", () => {
  const rules = faceFitRules();
  assert.equal(rules.length, 123);
  assert.equal(new Set(rules.map(r => r.ruleId)).size, 123, "rule_id 不能重复");
  const { valid, errors } = validateRuleSet(rules);
  assert.deepEqual(errors, []);
  assert.equal(valid.length, 123);
  assert.equal(new Set(valid.map(r => `${r.subDimension}|${r.humanField}|${r.itemField}`)).size, 12);
  const w: Record<string, Set<string>> = {};
  for (const r of valid) (w[r.subDimension] ??= new Set()).add(String(r.ruleWeight));
  assert.deepEqual(Object.fromEntries(Object.entries(w).map(([k, v]) => [k, [...v]])), {
    facial_line_echo: ["4.0"], feature_scale_echo: ["2.5"], contour_depth_echo: ["1.5"], neckline_proportion: ["2.0"],
  });
});

test("Face Fit：穷举——前三个子维度每个组合恰好一条规则，领型最多一条", () => {
  const rules = faceFitRules();
  const units = new Map<string, MatchingRule[]>();
  for (const r of rules) {
    const k = `${r.subDimension}|${r.humanField}|${r.itemField}`;
    units.set(k, [...(units.get(k) ?? []), r]);
  }
  for (const [k, rs] of units) {
    const [sub, hf, itf] = k.split("|");
    for (const hv of HUMAN_FIELDS[hf].values) {
      if (hv === "uncertain") continue;
      for (const iv of ITEM_FIELDS[itf].values) {
        const n = rs.filter(r => (r.humanValue as string[]).includes(hv) && (r.itemValue as string[]).includes(iv)).length;
        if (sub === "neckline_proportion") assert.ok(n <= 1, `${k} ${hv}×${iv} 命中 ${n} 条`);
        else assert.equal(n, 1, `${k} ${hv}×${iv} 命中 ${n} 条`);
      }
    }
  }
});

test("Face Fit：原因码齐全，positive → strength、penalty → warning、neutral 用 FF_NEUTRAL 占位", () => {
  const dir = new Map(FACE_FIT_REASONS.map(([c, , d]) => [c, d]));
  assert.equal(FACE_FIT_REASONS.length, 16);
  assert.ok(!dir.has("FF_NEUTRAL"), "FF_NEUTRAL 只是占位，不进入原因码表");
  for (const r of faceFitRules()) {
    if (r.matchType === "neutral") { assert.equal(r.reasonCode, "FF_NEUTRAL", r.ruleId); continue; }
    assert.equal(dir.get(r.reasonCode!), r.matchType === "positive" ? "strength" : "warning", r.ruleId);
  }
});

test("Face Fit：测试账号 × 测试商品（line_quality 为空）→ 56.46 / 0.6 / 0.667", async () => {
  const { dimensionResult: d } = await runFace(TEST_ITEM);
  assert.equal(d.score, 56.46);
  assert.equal(d.data_coverage, 0.6);
  assert.equal(d.rule_coverage, 0.667);
  assert.equal(d.confidence, 0.8);
  assert.deepEqual(d.strengths, ["FF_SCALE_ECHO"]);
  assert.deepEqual(d.warnings, ["FF_STRUCTURE_TOO_WEAK"]);
  assert.equal(d.rules_applied, 5);
  assert.equal(d.default_neutral_units, 2);
  assert.equal(d.units_skipped, 5);
  noNaN(d);
});

test("Face Fit：补录 line_quality = soft_curved → 60.28 / 1.0 / 0.8", async () => {
  const { dimensionResult: d, detail } = await runFace({ ...TEST_ITEM, lineQuality: "soft_curved" });
  assert.equal(d.score, 60.28);
  assert.equal(d.data_coverage, 1);
  assert.equal(d.rule_coverage, 0.8);
  assert.equal(d.confidence, 0.8);
  assert.deepEqual([...d.strengths].sort(), ["FF_BALANCED_ECHO", "FF_CURVE_ECHO", "FF_SCALE_ECHO"]);
  assert.deepEqual([...d.warnings].sort(), ["FF_LINE_TOO_SOFT", "FF_STRUCTURE_TOO_WEAK"]);
  const hit = Object.fromEntries(detail.units.filter((u: any) => u.rule_id).map((u: any) => [u.human_field, u.rule_id]));
  assert.deepEqual(hit, {
    cheek_contour: "FF_013", cheekbone_shape: "FF_021", chin_shape: "FF_037", nose_shape: "FF_045", eye_shape: "FF_053",
    eye_size: "FF_067", nose_size: "FF_083", mouth_fullness: "FF_094", cheekbone_prominence: "FF_107", nose_projection: "FF_112",
  });
});

test("Face Fit：neckline = other 按缺失处理，不按默认中性计分", async () => {
  const { detail } = await runFace({ ...TEST_ITEM, neckline: "other" });
  assert.deepEqual(statusOf(detail, "chin_length"), ["not_applicable"]);
  assert.deepEqual(statusOf(detail, "cheek_fullness"), ["not_applicable"]);
});

test("Face Fit：人侧 uncertain / 空值 → not_applicable；全部缺失时 score 为 null", async () => {
  const { detail } = await runFace(TEST_ITEM, { ...TEST_FACE, eyeSize: "uncertain", noseSize: null });
  assert.deepEqual(statusOf(detail, "eye_size"), ["not_applicable"]);
  assert.deepEqual(statusOf(detail, "nose_size"), ["not_applicable"]);
  const { dimensionResult: d } = await runFace(TEST_ITEM, {});
  assert.equal(d.score, null);
  assert.equal(d.data_coverage, 0);
  noNaN(d);
});

test("品类门控：face_fit 只对 tops / outerwear / dresses / one_piece；body_fit 不受限", () => {
  for (const c of ["tops", "outerwear", "dresses", "one_piece"]) assert.equal(channelAppliesTo("face_fit", c), true, c);
  for (const c of ["bottoms", "shoes", "bags", "accessories", null, undefined, "", "toString"]) {
    assert.equal(channelAppliesTo("face_fit", c), false, String(c));
  }
  for (const c of ["tops", "shoes", "bags", null]) assert.equal(channelAppliesTo("body_fit", c), true, String(c));
  for (const ch of ["toString", "__proto__", "constructor"]) assert.equal(channelAppliesTo(ch, "shoes"), true, ch);
  assert.deepEqual(Object.keys(CHANNEL_CATEGORY_SCOPE), ["face_fit"]);
});

test("汇总：只有 Body + Face 有效 → insufficient_coverage、dimension_coverage 0.3、总分 null", async () => {
  const face = (await runFace({ ...TEST_ITEM, lineQuality: "soft_curved" })).dimensionResult;
  const asInput = (d: any, dc: number) => ({
    score: d.score, data_coverage: dc, rule_coverage: d.rule_coverage, confidence: d.confidence,
    eligibility: d.eligibility, strengths: d.strengths, warnings: d.warnings,
    unit_validation_error_count: 0, engine_version: "matching_v1.0", rule_versions: d.rule_versions,
  });
  const body = { score: 78.33, data_coverage: 0.6, rule_coverage: 0.611, confidence: 0.8,
    eligibility: { purchase: true, recommendation: true, styling: true }, strengths: [], warnings: [],
    unit_validation_error_count: 0, engine_version: "matching_v1.0", rule_versions: ["v1.0", "v1.1"] };
  const out = aggregate({ dimensions: { body_fit: body, face_fit: asInput(face, 1) }, profile_version: 7 });
  assert.equal(out.overall_status, "insufficient_coverage");
  assert.equal(out.match_score, null);
  assert.equal(out.valid_dimensions, 2);
  assert.equal(out.dimension_coverage, 0.3);
  assert.equal(out.data_coverage, 0.22);
  // weights_used 输出保留 4 位小数：12 / 22、10 / 22
  assert.equal(out.weights_used.body_fit, 0.5455);
  assert.equal(out.weights_used.face_fit, 0.4545);
  // Face Fit 覆盖率低于 0.30 → invalid，dimension_coverage 回到 0.2
  const low = aggregate({ dimensions: { body_fit: body, face_fit: asInput(face, 0.15) }, profile_version: 7 });
  assert.equal(low.valid_dimensions, 1);
  assert.equal(low.dimension_coverage, 0.2);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
  }
  console.log(`\n${passed}/${tests.length} 通过`);
  if (passed !== tests.length) process.exit(1);
})();
