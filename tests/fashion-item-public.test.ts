// 运行：npx tsx tests/fashion-item-public.test.ts
// 离线测试 fashion-item-public.ts（商品库对普通用户开放的可见范围，2026-10-08），不连数据库。
import assert from "node:assert/strict";
import {
  isAdmin, toPublicItem, toPublicVariant, resolveListStatus, canViewItem,
  PUBLIC_ITEM_FIELDS, PUBLIC_VARIANT_FIELDS,
} from "../api/routes/fashion-item-public";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// 模拟 fashion_items 整行（含内部标注字段）
const ITEM_ROW = {
  id: 2, itemId: "AIFFD_ITEM_000002", brandName: "测试品牌", itemName: "米色针织衫",
  sourceCategory: "针织衫", category: "tops", subcategory: "knit", productUrl: "https://example.com/p/2",
  sourceSite: "example", status: "active",
  silhouette: "straight", shoulderStructure: "balanced", fit: "regular", lineQuality: "soft_straight",
  primaryStyle: "C", secondaryStyle: "SC", styleConfidence: "0.72",
  createdAt: new Date(), updatedAt: new Date(),
};
const VARIANT_ROW = {
  id: 1, variantId: "AIFFD_VARIANT_000001", itemId: "AIFFD_ITEM_000002",
  sku: "SKU-1", colorNameSource: "米色", sizeOptions: '["S","M","L"]', price: "299.00", currency: "CNY",
  availability: true, productUrl: null,
  inheritsItemStyle: true, overrideReason: null, variantStyleVersion: "v1", variantMaterialOverride: false,
  createdAt: new Date(), updatedAt: new Date(),
};

test("只有 role = admin 算管理员", () => {
  assert.equal(isAdmin("admin"), true);
  for (const r of ["user", "Admin", "", null, undefined, 1]) assert.equal(isAdmin(r), false, String(r));
});

test("商品展示字段：只保留白名单，内部标注与风格摘要全部去掉", () => {
  const p = toPublicItem(ITEM_ROW);
  assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_ITEM_FIELDS].sort());
  assert.equal(p.itemName, "米色针织衫");
  for (const k of ["id", "status", "sourceSite", "sourceCategory", "primaryStyle", "secondaryStyle",
    "styleConfidence", "silhouette", "fit", "lineQuality", "createdAt"]) {
    assert.ok(!(k in p), `${k} 不应对外`);
  }
});

test("变体展示字段：只保留白名单，sku 与风格继承字段去掉；缺失的白名单字段补 null", () => {
  const v = toPublicVariant(VARIANT_ROW);
  assert.deepEqual(Object.keys(v).sort(), [...PUBLIC_VARIANT_FIELDS].sort());
  assert.equal(v.price, "299.00");
  assert.equal(v.productUrl, null);
  for (const k of ["id", "itemId", "sku", "inheritsItemStyle", "overrideReason", "variantStyleVersion"]) {
    assert.ok(!(k in v), `${k} 不应对外`);
  }
  assert.equal(toPublicVariant({ variantId: "X" }).price, null);
});

test("表里新增的列默认不对外", () => {
  assert.ok(!("newInternalScore" in toPublicItem({ ...ITEM_ROW, newInternalScore: 0.9 })));
});

test("列表 status：admin 可查任意状态，默认 active；普通用户只能 active，传别的值报错", () => {
  assert.deepEqual(resolveListStatus("admin", undefined), { status: "active" });
  assert.deepEqual(resolveListStatus("admin", "archived"), { status: "archived" });
  assert.deepEqual(resolveListStatus("user", undefined), { status: "active" });
  assert.deepEqual(resolveListStatus("user", "active"), { status: "active" });
  for (const s of ["inactive", "archived", "draft", ""]) {
    assert.ok("error" in resolveListStatus("user", s), s);
  }
});

test("详情：admin 看全部状态；普通用户只看 active", () => {
  for (const s of ["active", "inactive", "archived"]) assert.equal(canViewItem("admin", s), true, s);
  assert.equal(canViewItem("user", "active"), true);
  for (const s of ["inactive", "archived", null, undefined]) assert.equal(canViewItem("user", s), false, String(s));
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
console.log(`\nfashion-item-public: ${passed}/${tests.length} 通过`);
if (passed !== tests.length) process.exit(1);
