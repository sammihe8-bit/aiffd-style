// 运行：npx tsx tests/item-images.test.ts
// 离线测试 item-images.ts（商品图片登记，2026-10-09），不连数据库。
import assert from "node:assert/strict";
import {
  validateItemImages, sortImages, isPublicImage, toPublicImage, pickPrimaryImageUrl,
  ItemImageInput, PUBLIC_IMAGE_FIELDS, MAX_IMAGES_PER_ITEM,
} from "../api/routes/item-images";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const OSS = "https://aiffd-images.oss-cn-beijing.aliyuncs.com/items/AIFFD_ITEM_000002/";
const BRAND = "https://www.ginatricot.com/img/sweater.jpg";
const VARIANTS = ["AIFFD_VARIANT_000001"];
const ok = (imgs: ItemImageInput[]) => assert.deepEqual(validateItemImages(imgs, VARIANTS), []);
const bad = (imgs: ItemImageInput[], hint: string) => {
  const p = validateItemImages(imgs, VARIANTS);
  assert.ok(p.some(x => x.includes(hint)), `应包含「${hint}」，实际 ${JSON.stringify(p)}`);
};

test("合法组合通过：自拍 owned、官网 unknown / authorized、官网 link_only、变体图；空数组也合法", () => {
  ok([
    { imageUrl: OSS + "01.jpg", sourceType: "brand_site", sourceUrl: BRAND, licenseStatus: "unknown", isPrimary: true, sortOrder: 0, width: 679, height: 879 },
    { imageUrl: OSS + "02.jpg", sourceType: "own_photo", licenseStatus: "owned", sortOrder: 1 },
    { imageUrl: OSS + "03.jpg", sourceType: "brand_site", licenseStatus: "authorized" },
    { imageUrl: BRAND, sourceType: "brand_site", sourceUrl: BRAND, licenseStatus: "link_only" },
    { imageUrl: OSS + "v1.jpg", variantId: "AIFFD_VARIANT_000001", sourceType: "own_photo", licenseStatus: "owned", isPrimary: true },
  ]);
  ok([]);
});

test("地址：必须 https，同一商品不重复", () => {
  bad([{ imageUrl: "http://a.com/x.jpg", sourceType: "own_photo", licenseStatus: "owned" }], "https");
  bad([{ imageUrl: "not a url", sourceType: "own_photo", licenseStatus: "owned" }], "https");
  bad([{ imageUrl: "https://a.com/" + "x".repeat(500), sourceType: "own_photo", licenseStatus: "owned" }], "最长 500");
  bad([
    { imageUrl: OSS + "01.jpg", sourceType: "own_photo", licenseStatus: "owned" },
    { imageUrl: OSS + "01.jpg", sourceType: "own_photo", licenseStatus: "owned", sortOrder: 1 },
  ], "重复");
});

test("来源与授权要对得上；link_only 必须 imageUrl = sourceUrl", () => {
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "unknown" }], "只能是 owned");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "own_photo" }], "只能是 owned");   // 默认 unknown
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "brand_site", licenseStatus: "owned" }], "不能是 owned");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "brand_site", sourceUrl: BRAND, licenseStatus: "link_only" }], "link_only");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "camera", licenseStatus: "owned" }], "sourceType");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "brand_site", sourceUrl: "ftp://x/y.jpg" }], "sourceUrl");
});

test("变体必须属于这件商品；同一范围最多一张主图，整款和变体分开算", () => {
  bad([{ imageUrl: OSS + "a.jpg", variantId: "AIFFD_VARIANT_999999", sourceType: "own_photo", licenseStatus: "owned" }], "不是这件商品的变体");
  bad([
    { imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "owned", isPrimary: true },
    { imageUrl: OSS + "b.jpg", sourceType: "own_photo", licenseStatus: "owned", isPrimary: true },
  ], "主图重复");
  ok([
    { imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "owned", isPrimary: true },
    { imageUrl: OSS + "b.jpg", variantId: "AIFFD_VARIANT_000001", sourceType: "own_photo", licenseStatus: "owned", isPrimary: true },
  ]);
});

test("数量、排序值、尺寸的范围", () => {
  const many = Array.from({ length: MAX_IMAGES_PER_ITEM + 1 }, (_, i) =>
    ({ imageUrl: `${OSS}${i}.jpg`, sourceType: "own_photo", licenseStatus: "owned" }));
  bad(many, "最多登记");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "owned", sortOrder: -1 }], "sortOrder");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "owned", width: 0 }], "width");
  bad([{ imageUrl: OSS + "a.jpg", sourceType: "own_photo", licenseStatus: "owned", height: 1.5 }], "height");
});

const ROWS = [
  { id: 1, itemId: "I", variantId: null, imageUrl: OSS + "side.jpg", sourceType: "own_photo", sourceUrl: null, licenseStatus: "owned", isPrimary: false, sortOrder: 2 },
  { id: 2, itemId: "I", variantId: "V", imageUrl: OSS + "v.jpg", sourceType: "own_photo", sourceUrl: null, licenseStatus: "owned", isPrimary: true, sortOrder: 0 },
  { id: 3, itemId: "I", variantId: null, imageUrl: OSS + "main.jpg", sourceType: "brand_site", sourceUrl: BRAND, licenseStatus: "unknown", isPrimary: true, sortOrder: 5 },
  { id: 4, itemId: "I", variantId: null, imageUrl: OSS + "back.jpg", sourceType: "own_photo", sourceUrl: null, licenseStatus: "owned", isPrimary: false, sortOrder: 1 },
];

test("排序：整款图在前，主图在前，再按 sortOrder", () => {
  assert.deepEqual(sortImages(ROWS).map(r => r.id), [3, 4, 1, 2]);
});

test("普通用户只看授权已确认的图片，且只有展示字段", () => {
  assert.equal(isPublicImage(ROWS[2]), false);   // unknown
  assert.equal(isPublicImage(ROWS[0]), true);
  for (const s of ["owned", "authorized", "link_only"]) assert.equal(isPublicImage({ licenseStatus: s }), true, s);
  const p = toPublicImage(ROWS[0]);
  assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_IMAGE_FIELDS].sort());
  for (const k of ["sourceType", "sourceUrl", "licenseStatus", "id", "itemId"]) assert.ok(!(k in p), `${k} 不应对外`);
  assert.equal(toPublicImage({ ...ROWS[0], isPrimary: 1 }).isPrimary, true);   // 库里 tinyint 也转成布尔
});

test("列表主图：admin 用整款主图；普通用户跳过未确认授权的图，退到下一张整款图；没有则 null", () => {
  assert.equal(pickPrimaryImageUrl(ROWS, false), OSS + "main.jpg");
  assert.equal(pickPrimaryImageUrl(ROWS, true), OSS + "back.jpg");
  assert.equal(pickPrimaryImageUrl([ROWS[1]], false), null);   // 只有变体图
  assert.equal(pickPrimaryImageUrl([], true), null);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
console.log(`\nitem-images: ${passed}/${tests.length} 通过`);
if (passed !== tests.length) process.exit(1);
