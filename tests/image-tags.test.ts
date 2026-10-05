// 运行：npm run test:matching（或 npx tsx tests/image-tags.test.ts）
// 离线测试 api/routes/image-tags.ts（风格形象标签写入校验，2026-10-05），不连数据库。
import assert from "node:assert/strict";
import {
  validateProfileImageTagPatch, validateItemImageTags, parseStoredTags, canonicalOrder, PROFILE_IMAGE_TAG_FIELDS,
} from "../api/routes/image-tags";
import { IMAGE_TAGS, humanStyleProfiles } from "../db/schema";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const EMPTY = {};   // 没做过偏好测试的档案
// 一次完整、合法的偏好测试提交（顺序故意打乱，检验排序）
const FULL = {
  aspiredImageTags: ["soft_romantic", "clean_intellectual", "refined_elegant"],
  aspiredImageTagFavorite: "refined_elegant",
  currentImageTags: ["relaxed_natural"],
  currentImageStatus: "selected",
  rejectedImageTags: ["androgynous_sharp", "glamorous_mature"],
};
const v = (patch: Record<string, unknown>, current: Record<string, unknown> = EMPTY) => validateProfileImageTagPatch(patch, current);
const ok = (patch: Record<string, unknown>, current?: Record<string, unknown>) => {
  const r = v(patch, current);
  assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  return r.normalized;
};
const bad = (patch: Record<string, unknown>, hint: string, current?: Record<string, unknown>) => {
  const r = v(patch, current);
  assert.ok(r.problems.some(p => p.includes(hint)), `应包含「${hint}」，实际 ${JSON.stringify(r.problems)}`);
  assert.deepEqual(r.normalized, {}, "校验失败时不返回任何可写入的字段");
};

// ── 词汇与 schema ───────────────────────────────────────────────
test("12 个标签与 schema 一致；人侧 5 个字段在 schema 里都有定义", () => {
  assert.equal(IMAGE_TAGS.length, 12);
  assert.equal(new Set(IMAGE_TAGS).size, 12);
  for (const f of PROFILE_IMAGE_TAG_FIELDS) assert.ok(f in humanStyleProfiles, f);
  assert.deepEqual([...humanStyleProfiles.currentImageStatus.enumValues], ["selected", "no_fixed_style"]);
});

// ── 人侧：完整提交 ───────────────────────────────────────────────
test("完整合法提交通过，数组按 IMAGE_TAGS 顺序排序", () => {
  const n = ok(FULL);
  assert.deepEqual(n.aspiredImageTags, ["clean_intellectual", "refined_elegant", "soft_romantic"]);
  assert.deepEqual(n.rejectedImageTags, ["glamorous_mature", "androgynous_sharp"]);
  assert.equal(n.aspiredImageTagFavorite, "refined_elegant");
  assert.deepEqual(n.currentImageTags, ["relaxed_natural"]);
});

test("不含这 5 个字段的 PATCH 不受影响（如体型、色彩字段）", () => {
  assert.deepEqual(v({ warmCool: "warm", seasonName: "夏" }), { problems: [], normalized: {} });
});

test("Q2“没有固定风格”与 Q3“没有特别排斥的”：空数组合法", () => {
  ok({ ...FULL, currentImageTags: [], currentImageStatus: "no_fixed_style", rejectedImageTags: [] });
});

test("“最喜欢”可以不标", () => ok({ ...FULL, aspiredImageTagFavorite: null }));

test("全部置 null（清空偏好）合法", () => {
  ok({ aspiredImageTags: null, aspiredImageTagFavorite: null, currentImageTags: null, currentImageStatus: null, rejectedImageTags: null }, FULL);
});

// ── 人侧：逐字段校验 ─────────────────────────────────────────────
test("理想形象 3～5 个；常穿最多 3 个", () => {
  bad({ ...FULL, aspiredImageTags: ["soft_romantic", "refined_elegant"] }, "aspiredImageTags 需要 3～5 个");
  bad({ ...FULL, aspiredImageTags: IMAGE_TAGS.slice(0, 6) as unknown as string[], aspiredImageTagFavorite: null, rejectedImageTags: [] }, "aspiredImageTags 需要 3～5 个");
  bad({ ...FULL, currentImageTags: ["relaxed_natural", "urban_modern", "youthful_energetic", "vintage_literary"] }, "currentImageTags 需要 0～3 个");
});

test("非法标签（含 13 型代码、中文名、toString、__proto__）、重复标签、非数组 → 拒绝", () => {
  for (const x of ["R", "温柔浪漫", "toString", "__proto__", "constructor", "", 3]) {
    bad({ ...FULL, rejectedImageTags: [x] }, "rejectedImageTags 含非法标签");
  }
  bad({ ...FULL, rejectedImageTags: ["urban_modern", "urban_modern"] }, "有重复标签");
  bad({ ...FULL, aspiredImageTags: '["soft_romantic","refined_elegant","clean_intellectual"]' }, "必须是标签数组或 null");
  bad({ ...FULL, aspiredImageTagFavorite: "R" }, "aspiredImageTagFavorite 必须是标签 id");
  bad({ ...FULL, currentImageStatus: "none" }, "currentImageStatus 必须是");
});

// ── 人侧：交叉校验 ───────────────────────────────────────────────
test("“最喜欢”必须在理想形象里", () => {
  bad({ ...FULL, aspiredImageTagFavorite: "urban_modern" }, "必须是 aspiredImageTags 里的一个标签");
});

test("常穿标签与状态：no_fixed_style 必须空数组；selected 至少 1 个；两者必须同时有值或同时为空", () => {
  bad({ ...FULL, currentImageStatus: "no_fixed_style" }, "必须为空数组");
  bad({ ...FULL, currentImageTags: [] }, "至少要有 1 个标签");
  bad({ ...FULL, currentImageStatus: null }, "必须同时有值或同时为空");
});

test("同一标签不能既是理想形象又是排斥形象", () => {
  bad({ ...FULL, rejectedImageTags: ["soft_romantic"] }, "既是理想形象又是排斥形象");
});

test("只提交部分字段时，用库里现值做交叉校验", () => {
  const stored = {
    aspiredImageTags: '["clean_intellectual","refined_elegant","soft_romantic"]',
    aspiredImageTagFavorite: "refined_elegant",
    currentImageTags: '["relaxed_natural"]', currentImageStatus: "selected", rejectedImageTags: "[]",
  };
  ok({ rejectedImageTags: ["urban_modern"] }, stored);
  bad({ rejectedImageTags: ["refined_elegant"] }, "既是理想形象又是排斥形象", stored);
  bad({ aspiredImageTags: ["urban_modern", "youthful_energetic", "vintage_literary"] }, "必须是 aspiredImageTags 里的一个标签", stored);
  bad({ currentImageStatus: "no_fixed_style" }, "必须为空数组", stored);
});

test("库里坏数据按 null 处理，不会让合法提交失败", () => {
  assert.equal(parseStoredTags("不是JSON"), null);
  assert.equal(parseStoredTags('{"a":1}'), null);
  assert.equal(parseStoredTags("[1,2]"), null);
  assert.deepEqual(parseStoredTags('["urban_modern"]'), ["urban_modern"]);
  ok(FULL, { aspiredImageTags: "坏数据", rejectedImageTags: 42 });
});

test("排序稳定：同一组选择不同提交顺序得到同一个结果", () => {
  const a = canonicalOrder(["oriental_refined", "clean_intellectual", "urban_modern"]);
  const b = canonicalOrder(["urban_modern", "oriental_refined", "clean_intellectual"]);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), '["clean_intellectual","urban_modern","oriental_refined"]');
});

// ── 商品侧 ─────────────────────────────────────────────────────
test("商品标签：三档分值、部分标签、空数组都合法（未提交的标签 = 未评估）", () => {
  assert.deepEqual(validateItemImageTags([
    { tagId: "soft_romantic", score: 1 }, { tagId: "clean_intellectual", score: 0.5, confidence: 0.8 },
    { tagId: "androgynous_sharp", score: 0 },
  ]), []);
  assert.deepEqual(validateItemImageTags([]), []);
});

test("商品标签：非法 / 重复标签、分值越界或超过两位小数、置信度越界 → 拒绝", () => {
  const has = (p: string[], s: string) => assert.ok(p.some(x => x.includes(s)), `${s}：${JSON.stringify(p)}`);
  has(validateItemImageTags([{ tagId: "R", score: 1 }]), "非法标签");
  has(validateItemImageTags([{ tagId: "__proto__", score: 1 }]), "非法标签");
  has(validateItemImageTags([{ tagId: "urban_modern", score: 1 }, { tagId: "urban_modern", score: 0 }]), "标签重复");
  for (const s of [-0.1, 1.2, 0.333, NaN, Infinity]) has(validateItemImageTags([{ tagId: "urban_modern", score: s }]), "score");
  has(validateItemImageTags([{ tagId: "urban_modern", score: 1, confidence: 1.5 }]), "confidence");
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); process.exitCode = 1; }
}
console.log(`\nimage-tags: ${passed}/${tests.length} 通过`);
