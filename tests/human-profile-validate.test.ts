// 运行：npx tsx tests/human-profile-validate.test.ts
// 离线测试 human-profile-validate.ts（Style 数据缺口修复，2026-10-02），不连数据库。
import assert from "node:assert/strict";
import { validateStyleScores, validateStyleCodePatch, roundProbability, StyleScoreInput } from "../api/routes/human-profile-validate";
import { STYLE_CODES } from "../db/schema";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// 前端 computeStyleProbabilities 对一组真实模拟答案的输出（主型 FG，次型 SG）
const SAMPLE: Record<string, number> = {
  R: 0.313, TR: 0.313, SG: 0.591, G: 0.561, FG: 0.62, SC: 0.363, C: 0.195,
  DC: 0.195, SN: 0.445, N: 0.214, FN: 0.339, SD: 0.503, D: 0.311,
};
const valid = (): StyleScoreInput[] => STYLE_CODES.map(c => ({
  styleCode: c, probability: SAMPLE[c], isPrimary: c === "FG", isSecondary: c === "SG",
}));
const ok = (s: StyleScoreInput[]) => assert.deepEqual(validateStyleScores(s), []);
const bad = (s: StyleScoreInput[], hint: string) => {
  const p = validateStyleScores(s);
  assert.ok(p.some(x => x.includes(hint)), `应包含「${hint}」，实际 ${JSON.stringify(p)}`);
};

test("合法的 13 型分布通过", () => ok(valid()));

test("次型可以为空（01B：次型可为空）", () => ok(valid().map(s => ({ ...s, isSecondary: false }))));

test("主型与其他型概率并列最高也合法", () => ok(valid().map(s => s.styleCode === "SG" ? { ...s, probability: 0.62 } : s)));

test("少于 13 型 / 多于 13 型 → 拒绝", () => {
  bad(valid().slice(0, 12), "必须提交全部 13 型");
  bad([...valid(), { styleCode: "R", probability: 0.1 }], "必须提交全部 13 型");
});

test("非法代码、中文名、重复代码 → 拒绝", () => {
  bad(valid().map(s => s.styleCode === "R" ? { ...s, styleCode: "X" } : s), "非法风格代码");
  bad(valid().map(s => s.styleCode === "R" ? { ...s, styleCode: "浪漫型风格" } : s), "非法风格代码");
  bad(valid().map(s => s.styleCode === "R" ? { ...s, styleCode: "TR" } : s), "风格代码重复");
});

test("probability 越界或非有限数 → 拒绝", () => {
  for (const v of [-0.1, 1.2, NaN, Infinity]) bad(valid().map(s => s.styleCode === "R" ? { ...s, probability: v } : s), "probability");
});

test("主型缺失 / 多个主型 → 拒绝", () => {
  bad(valid().map(s => ({ ...s, isPrimary: false })), "主型必须恰好 1 个");
  bad(valid().map(s => s.styleCode === "R" ? { ...s, isPrimary: true } : s), "主型必须恰好 1 个");
});

test("主型不是概率最高 → 拒绝", () => {
  bad(valid().map(s => s.styleCode === "D" ? { ...s, probability: 0.9 } : s), "不是概率最高项");
});

test("多个次型、主次同一型、次型不是第二高 → 拒绝", () => {
  bad(valid().map(s => s.styleCode === "G" ? { ...s, isSecondary: true } : s), "次型最多 1 个");
  bad(valid().map(s => ({ ...s, isSecondary: s.styleCode === "FG" })), "同时是主型和次型");
  bad(valid().map(s => ({ ...s, isSecondary: s.styleCode === "D" })), "不是概率第二高项");
});

test("比较按 3 位小数（与 decimal(4,3) 一致）：0.6204 与 0.6196 视为并列", () => {
  assert.equal(roundProbability(0.6204), 0.62);
  ok(valid().map(s => s.styleCode === "SG" ? { ...s, probability: 0.6204 } : s.styleCode === "FG" ? { ...s, probability: 0.6196 } : s));
});

test("PATCH 主型 / 次型：13 型代码与 null 通过；中文名、小写、其他类型拒绝；其他字段不受影响", () => {
  assert.deepEqual(validateStyleCodePatch({ primaryStyle: "FG", secondaryStyle: "SG" }), []);
  assert.deepEqual(validateStyleCodePatch({ secondaryStyle: null }), []);
  assert.deepEqual(validateStyleCodePatch({ styleElement: "金", eyeSize: "small" }), []);
  for (const v of ["戏剧少年型", "fg", "", 3, ["FG"], {}]) {
    assert.equal(validateStyleCodePatch({ primaryStyle: v }).length, 1, JSON.stringify(v));
  }
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
console.log(`\n${passed}/${tests.length} 通过`);
if (passed !== tests.length) process.exit(1);
