// 运行：npx tsx tests/consents.test.ts
// 离线测试 consents-validate.ts（2026-10-18），不连数据库。
import assert from "node:assert/strict";
import { consentInputSchema, resolveConsentedAt } from "../api/routes/consents-validate";

let passed = 0;
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

const base = { ageAndResearchAck: true, privacyAck: true, photoConsent: false, researchDataConsent: true, policyVersion: "v1.0-2026-09" };
const ok = (v: unknown) => consentInputSchema.parse(v);
const bad = (v: unknown, hint: string) => {
  const r = consentInputSchema.safeParse(v);
  assert.ok(!r.success, `应拒绝：${JSON.stringify(v)}`);
  assert.ok(JSON.stringify(r.error.errors).includes(hint), `应包含「${hint}」，实际 ${JSON.stringify(r.error.errors)}`);
};

test("合法提交通过，source 默认 onboarding", () => {
  assert.equal(ok(base).source, "onboarding");
});

test("两项必选授权缺任何一项 → 拒绝", () => {
  bad({ ...base, ageAndResearchAck: false }, "18 岁");
  bad({ ...base, privacyAck: false }, "隐私政策");
  bad({ ...base, privacyAck: undefined }, "隐私政策");
});

test("可选授权必须是布尔值", () => {
  bad({ ...base, photoConsent: "yes" }, "photoConsent");
  bad({ ...base, researchDataConsent: undefined }, "researchDataConsent");
});

test("协议版本不能为空、不能超过 30 字", () => {
  bad({ ...base, policyVersion: "  " }, "policyVersion");
  bad({ ...base, policyVersion: "x".repeat(31) }, "policyVersion");
});

test("未知字段 → 拒绝（防止写入 userId 等字段）", () => {
  bad({ ...base, userId: 1 }, "unrecognized_keys");
});

test("consentedAt 必须是带时区的 ISO 时间，且在合理范围内", () => {
  ok({ ...base, source: "local_backfill", consentedAt: "2026-09-20T08:00:00.000Z" });
  bad({ ...base, source: "local_backfill", consentedAt: "2026/09/20" }, "consentedAt");
  bad({ ...base, source: "local_backfill", consentedAt: "2020-01-01T00:00:00Z" }, "合理范围");
  bad({ ...base, source: "local_backfill", consentedAt: new Date(Date.now() + 3600_000).toISOString() }, "合理范围");
});

test("同意时间：onboarding 用服务器时间，忽略客户端上报；补传用本机记录时间", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const onb = ok({ ...base, consentedAt: "2026-10-01T00:00:00Z" });
  assert.equal(resolveConsentedAt(onb, now)?.toISOString(), now.toISOString());
  const back = ok({ ...base, source: "local_backfill", consentedAt: "2026-09-20T08:00:00.000Z" });
  assert.equal(resolveConsentedAt(back, now)?.toISOString(), "2026-09-20T08:00:00.000Z");
  const backNoTime = ok({ ...base, source: "local_backfill" });
  assert.equal(resolveConsentedAt(backNoTime, now), null);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}
console.log(`\nconsents: ${passed}/${tests.length} 通过`);
if (passed !== tests.length) process.exit(1);
