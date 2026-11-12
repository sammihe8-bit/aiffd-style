// 2026-11-12 新增：档案的每一次变化（主表字段或子表）都走这里，在同一个数据库事务里完成：
//   1. 锁住档案行（SELECT … FOR UPDATE），版本号在锁内计算，两个请求同时改同一份档案也不会拿到同一个版本号；
//   2. 写入变化（由调用方在事务里完成）；
//   3. profile_version +1、写字段级变更日志、存一份变化后的完整档案快照（profile_versions）。
// 任何一步失败整体回滚：不会再出现“字段改了却没有日志”或“日志写了一半”。
import { db } from "../../db";
import {
  humanStyleProfiles, profileStyleScores, profileFieldChangeLog, profileVersions,
  profileLifestyleScenarios, profileItemPreferences, profileVisualStylePreferences, profileColorSignals,
  type HumanStyleProfile,
} from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { buildSnapshot, type FieldChange } from "./profile-revision-core";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ChangeSource = typeof profileFieldChangeLog.$inferInsert["source"];

export async function lockProfile(tx: Tx, profileRowId: number): Promise<HumanStyleProfile> {
  const rows = await tx.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.id, profileRowId)).for("update");
  if (rows.length === 0) throw new Error(`profile row ${profileRowId} not found`);
  return rows[0];
}

async function loadSnapshot(tx: Tx, profileRowId: number, profileId: string) {
  const [profile] = await tx.select().from(humanStyleProfiles).where(eq(humanStyleProfiles.id, profileRowId));
  const [styleScores, lifestyleScenarios, itemPreferences, visualStylePreferences, colorSignals] = await Promise.all([
    tx.select().from(profileStyleScores).where(eq(profileStyleScores.profileId, profileId)),
    tx.select().from(profileLifestyleScenarios).where(eq(profileLifestyleScenarios.profileId, profileId)),
    tx.select().from(profileItemPreferences).where(eq(profileItemPreferences.profileId, profileId)),
    tx.select().from(profileVisualStylePreferences).where(eq(profileVisualStylePreferences.profileId, profileId)),
    tx.select().from(profileColorSignals)
      .where(and(eq(profileColorSignals.profileId, profileId), eq(profileColorSignals.isPrimary, true))),
  ]);
  return { row: profile, snapshot: buildSnapshot({ profile: profile as Record<string, unknown>, styleScores, lifestyleScenarios, itemPreferences, visualStylePreferences, colorSignals }) };
}

// 建表前就存在的档案：第一次变化前先补存“变化前”的状态，这样版本链从变化前就是完整的
async function ensureBaseline(tx: Tx, locked: HumanStyleProfile) {
  const existing = await tx.select({ id: profileVersions.id }).from(profileVersions)
    .where(and(eq(profileVersions.profileId, locked.profileId), eq(profileVersions.profileVersion, locked.profileVersion))).limit(1);
  if (existing.length > 0) return;
  const { snapshot } = await loadSnapshot(tx, locked.id, locked.profileId);
  await tx.insert(profileVersions).values({
    profileId: locked.profileId, profileVersion: locked.profileVersion, snapshotKind: "baseline",
    snapshot, source: locked.lastUpdatedSource ?? null, changedByUserId: null,
  });
}

// 在事务里、档案已锁、子表变化已写入之后调用。changes 为空时什么都不做（不升版本）。
export async function commitRevision(tx: Tx, args: {
  locked: HumanStyleProfile;
  changes: FieldChange[];
  mainTableUpdate?: Record<string, unknown>;
  source: ChangeSource;
  reason?: string | null;
  changedByUserId: number;
}): Promise<HumanStyleProfile> {
  const { locked, changes, source, changedByUserId } = args;
  if (changes.length === 0) return locked;
  await ensureBaseline(tx, locked);

  const newVersion = locked.profileVersion + 1;
  await tx.update(humanStyleProfiles)
    .set({ ...(args.mainTableUpdate ?? {}), profileVersion: newVersion, lastUpdatedSource: source })
    .where(eq(humanStyleProfiles.id, locked.id));
  await tx.insert(profileFieldChangeLog).values(changes.map(c => ({
    profileId: locked.profileId, profileVersion: newVersion,
    fieldName: c.fieldName, oldValue: c.oldValue, newValue: c.newValue,
    reason: args.reason ?? null, source, changedByUserId,
  })));
  const { row, snapshot } = await loadSnapshot(tx, locked.id, locked.profileId);
  await tx.insert(profileVersions).values({
    profileId: locked.profileId, profileVersion: newVersion, snapshotKind: "revision",
    snapshot, source, changedByUserId,
  });
  return row;
}
