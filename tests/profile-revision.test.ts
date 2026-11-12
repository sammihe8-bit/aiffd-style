// 2026-11-12：档案修订（事务 + 字段日志 + 版本快照）的测试。不连数据库：
//   · 纯函数（差异比较、子表规范化、快照组装）直接测；
//   · commitRevision 用一个记录调用的假事务对象测写入顺序与内容；
//   · 锁行语句用 drizzle 的 toSQL() 检查确实带 FOR UPDATE。
import assert from "node:assert/strict";
import { diffProfileFields, canonicalStyleScores, canonicalScenarios, buildSnapshot, stringifyFieldValue } from "../api/routes/profile-revision-core";
import { commitRevision } from "../api/routes/profile-revision";
import { db } from "../db";
import { humanStyleProfiles, profileVersions, profileFieldChangeLog, profileStyleScores } from "../db/schema";
import { eq } from "drizzle-orm";

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => { await fn(); passed++; console.log("  ✓", name); };

async function main() {
await test("diffProfileFields：只记录真正变化的字段，数组按 JSON 存", () => {
  const { updateData, changes } = diffProfileFields(
    { heightRange: "160-165", waistType: '["直"]', ageRange: null },
    { heightRange: "160-165", waistType: ["细"], ageRange: "25-34" },
    ["heightRange", "waistType", "ageRange"],
  );
  assert.deepEqual(updateData, { waistType: '["细"]', ageRange: "25-34" });
  assert.deepEqual(changes, [
    { fieldName: "waist_type", oldValue: '["直"]', newValue: '["细"]' },
    { fieldName: "age_range", oldValue: "", newValue: "25-34" },
  ]);
});

await test("stringifyFieldValue：日期转 ISO，空值为空串", () => {
  assert.equal(stringifyFieldValue(new Date("2026-11-12T00:00:00Z")), "2026-11-12T00:00:00.000Z");
  assert.equal(stringifyFieldValue(null), "");
});

await test("canonicalStyleScores：顺序、小数位、引擎版本不影响结果；概率变化会被识别", () => {
  const a = canonicalStyleScores([
    { styleCode: "R", probability: "0.400", isPrimary: true, isSecondary: false },
    { styleCode: "C", probability: 0.1, isPrimary: false, isSecondary: true },
  ]);
  const b = canonicalStyleScores([
    { styleCode: "C", probability: "0.100", isPrimary: false, isSecondary: true },
    { styleCode: "R", probability: 0.4, isPrimary: true, isSecondary: false },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, canonicalStyleScores([
    { styleCode: "C", probability: 0.11, isPrimary: false, isSecondary: true },
    { styleCode: "R", probability: 0.39, isPrimary: true, isSecondary: false },
  ]));
  assert.equal(canonicalStyleScores([]), "");
});

await test("canonicalScenarios：顺序无关，权重统一 3 位小数", () => {
  const x = { scenarioParent: "work", scenarioType: "predefined", scenarioName: null, isFocus: true, weight: "0.600" };
  const y = { scenarioParent: "casual", scenarioType: "predefined", scenarioName: null, isFocus: false, weight: 0.4 };
  assert.equal(canonicalScenarios([x, y]), canonicalScenarios([{ ...y, weight: "0.400" }, { ...x, weight: 0.6 }]));
});

await test("buildSnapshot：子表去掉 id/时间戳并排序", () => {
  const snap = buildSnapshot({
    profile: { profileId: "AIFFD_PROFILE_000001", profileVersion: 3 },
    styleScores: [{ styleCode: "R", probability: "0.400", isPrimary: true, isSecondary: false, engineVersion: "v2", calculatedAt: null }],
    lifestyleScenarios: [],
    itemPreferences: [{ itemType: "skirt", preferenceLevel: "like" }, { itemType: "blazer", preferenceLevel: "dislike" }],
    visualStylePreferences: [],
    colorSignals: [{ signalType: "skin_tone", value: "warm_ivory", sourceMethod: "questionnaire", confidence: null }],
  });
  assert.deepEqual(snap.itemPreferences.map(p => p.itemType), ["blazer", "skirt"]);
  assert.deepEqual(snap.styleScores[0], { styleCode: "R", probability: "0.400", isPrimary: true, isSecondary: false, engineVersion: "v2", calculatedAt: null });
  assert.equal("id" in snap.itemPreferences[0], false);
});

await test("锁行语句带 FOR UPDATE", () => {
  const q = db.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.id, 1)).for("update").toSQL();
  assert.match(q.sql, /for update$/i);
});

// ── 假事务：按表记录写入，select 按表返回预设数据 ──
function fakeTx(opts: { hasBaseline: boolean }) {
  const log: { op: string; table: unknown; data?: unknown }[] = [];
  const profileRow = { id: 7, profileId: "AIFFD_PROFILE_000007", profileVersion: 4, lastUpdatedSource: "body_test", heightRange: "160-165" };
  const rowsFor = (table: unknown): unknown[] => {
    if (table === humanStyleProfiles) return [profileRow];
    if (table === profileVersions) return opts.hasBaseline ? [{ id: 1 }] : [];
    if (table === profileStyleScores) return [];
    return [];
  };
  const chain = (table: unknown) => {
    const p: any = Promise.resolve(rowsFor(table));
    p.where = () => chain(table); p.limit = () => chain(table); p.for = () => chain(table);
    return p;
  };
  const tx: any = {
    select: () => ({ from: (t: unknown) => chain(t) }),
    insert: (t: unknown) => ({ values: async (data: unknown) => { log.push({ op: "insert", table: t, data }); } }),
    update: (t: unknown) => ({ set: (data: unknown) => ({ where: async () => { log.push({ op: "update", table: t, data }); } }) }),
  };
  return { tx, log, profileRow };
}

await test("commitRevision：没有变化时不写任何东西、不升版本", async () => {
  const { tx, log, profileRow } = fakeTx({ hasBaseline: false });
  const row = await commitRevision(tx, { locked: profileRow as any, changes: [], source: "body_test", changedByUserId: 1 });
  assert.equal(row, profileRow);
  assert.equal(log.length, 0);
});

await test("commitRevision：老档案第一次变化 → 先存 baseline，再更新主表、写日志、存 revision 快照", async () => {
  const { tx, log, profileRow } = fakeTx({ hasBaseline: false });
  await commitRevision(tx, {
    locked: profileRow as any, source: "body_test", changedByUserId: 90001, reason: "体型重测",
    mainTableUpdate: { heightRange: "165-170" },
    changes: [{ fieldName: "height_range", oldValue: "160-165", newValue: "165-170" }],
  });
  assert.deepEqual(log.map(l => [l.op, l.table === profileVersions ? "versions" : l.table === humanStyleProfiles ? "profiles" : l.table === profileFieldChangeLog ? "log" : "?"]),
    [["insert", "versions"], ["update", "profiles"], ["insert", "log"], ["insert", "versions"]]);
  const baseline = log[0].data as any;
  assert.equal(baseline.snapshotKind, "baseline"); assert.equal(baseline.profileVersion, 4); assert.equal(baseline.source, "body_test");
  assert.deepEqual(log[1].data, { heightRange: "165-170", profileVersion: 5, lastUpdatedSource: "body_test" });
  const logs = log[2].data as any[];
  assert.equal(logs.length, 1); assert.equal(logs[0].profileVersion, 5); assert.equal(logs[0].reason, "体型重测");
  const rev = log[3].data as any;
  assert.equal(rev.snapshotKind, "revision"); assert.equal(rev.profileVersion, 5); assert.equal(rev.changedByUserId, 90001);
  assert.ok(rev.snapshot.profile);
});

await test("commitRevision：已有 baseline 时不重复存", async () => {
  const { tx, log, profileRow } = fakeTx({ hasBaseline: true });
  await commitRevision(tx, { locked: profileRow as any, source: "face_test", changedByUserId: 1,
    changes: [{ fieldName: "style_scores", oldValue: "", newValue: "[]" }] });
  assert.equal(log.filter(l => l.table === profileVersions).length, 1);
});

console.log(`profile-revision：${passed} 项通过`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
