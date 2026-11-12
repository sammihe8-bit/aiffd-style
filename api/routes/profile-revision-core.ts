// 2026-11-12 新增：档案修订（profile_version +1）里不碰数据库的部分，单独放这里方便测试。
import { toSnakeCase } from "./human-profile-validate";

export type FieldChange = { fieldName: string; oldValue: string; newValue: string };

export function stringifyFieldValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// 主表字段：对比旧档案与 patch，返回要写入的数据和字段级变更（值没变的字段不写、不记）
export function diffProfileFields(
  profile: Record<string, unknown>, patch: Record<string, unknown>, keys: string[],
): { updateData: Record<string, unknown>; changes: FieldChange[] } {
  const updateData: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  for (const key of keys) {
    let newVal = patch[key];
    if (Array.isArray(newVal) || (typeof newVal === "object" && newVal !== null)) newVal = JSON.stringify(newVal);
    const oldStr = stringifyFieldValue(profile[key]);
    const newStr = stringifyFieldValue(newVal);
    if (oldStr === newStr) continue;
    updateData[key] = newVal;
    changes.push({ fieldName: toSnakeCase(key), oldValue: oldStr, newValue: newStr });
  }
  return { updateData, changes };
}

// ── 子表的规范化表示：同样的内容永远序列化成同一个字符串，用来判断“有没有变”和写变更日志 ──

type StyleScoreLike = { styleCode: string; probability: string | number; isPrimary: boolean; isSecondary: boolean };
// 13 型分布：按代码排序，概率统一保留 3 位小数；engine_version / calculated_at 不算内容变化
export function canonicalStyleScores(rows: StyleScoreLike[]): string {
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) => a.styleCode.localeCompare(b.styleCode));
  return JSON.stringify(sorted.map(r => ({
    code: r.styleCode, p: Number(r.probability).toFixed(3),
    ...(r.isPrimary ? { primary: true } : {}), ...(r.isSecondary ? { secondary: true } : {}),
  })));
}

type ScenarioLike = { scenarioParent: string; scenarioType: string; scenarioName: string | null; isFocus: boolean; weight: string | number };
export function canonicalScenarios(rows: ScenarioLike[]): string {
  if (rows.length === 0) return "";
  const items = rows.map(r => ({
    parent: r.scenarioParent, type: r.scenarioType, name: r.scenarioName ?? "",
    focus: !!r.isFocus, weight: Number(r.weight).toFixed(3),
  }));
  items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(items);
}

// 整份档案快照：主表 + 各子表（只取内容字段，去掉自增 id / 外键 / 时间戳，避免快照里全是噪声）
export function buildSnapshot(parts: {
  profile: Record<string, unknown>;
  styleScores: (StyleScoreLike & { engineVersion?: string | null; calculatedAt?: Date | null })[];
  lifestyleScenarios: ScenarioLike[];
  itemPreferences: { itemType: string; preferenceLevel: string }[];
  visualStylePreferences: { visualStyleTag: string; preferenceLevel: string }[];
  colorSignals: { signalType: string; value: string; sourceMethod: string; confidence: string | null }[];
}) {
  const sortBy = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    profile: parts.profile,
    styleScores: sortBy(parts.styleScores, r => r.styleCode).map(r => ({
      styleCode: r.styleCode, probability: Number(r.probability).toFixed(3), isPrimary: !!r.isPrimary, isSecondary: !!r.isSecondary,
      engineVersion: r.engineVersion ?? null, calculatedAt: r.calculatedAt ? new Date(r.calculatedAt).toISOString() : null,
    })),
    lifestyleScenarios: JSON.parse(canonicalScenarios(parts.lifestyleScenarios) || "[]"),
    itemPreferences: sortBy(parts.itemPreferences, r => r.itemType).map(r => ({ itemType: r.itemType, preferenceLevel: r.preferenceLevel })),
    visualStylePreferences: sortBy(parts.visualStylePreferences, r => r.visualStyleTag)
      .map(r => ({ visualStyleTag: r.visualStyleTag, preferenceLevel: r.preferenceLevel })),
    colorSignals: sortBy(parts.colorSignals, r => r.signalType)
      .map(r => ({ signalType: r.signalType, value: r.value, sourceMethod: r.sourceMethod, confidence: r.confidence })),
  };
}
