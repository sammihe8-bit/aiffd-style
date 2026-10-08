import { STYLE_CODES } from "../../db/schema";

// ══════════════════════════════════════════════════════════════════
// Human Profile 写入校验（纯函数，不访问数据库，可单独测试）
// 2026-10-02 新增：Style 数据缺口修复
//   1. POST /me/style-scores 的 13 型概率分布校验（对齐 01B 第四节）
//   2. PATCH /me 里 primaryStyle / secondaryStyle 只接受 13 型代码
//      （2026-10-08 扩展到 aspiredStylePrimary / aspiredStyleSecondary / currentStyle / rejectedStyleCodes）
// ══════════════════════════════════════════════════════════════════

const CODE_SET = new Set<string>(STYLE_CODES);

export type StyleScoreInput = {
  styleCode: string;
  probability: number;
  isPrimary?: boolean;
  isSecondary?: boolean;
};

// 与数据库 decimal(4,3) 一致：先按 3 位小数取整，再做大小比较
export const roundProbability = (p: number) => Math.round(p * 1000) / 1000;

// 返回问题列表；空数组表示合法
// 规则：13 型齐全且不重复；每项 0~1；主型恰好 1 个且概率最高（可并列）；
//       次型最多 1 个、不能与主型相同、概率在其余 12 项里最高（可并列）
export function validateStyleScores(scores: StyleScoreInput[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(scores)) return ["scores 必须是数组"];
  if (scores.length !== STYLE_CODES.length) problems.push(`必须提交全部 ${STYLE_CODES.length} 型，实际 ${scores.length} 项`);

  const seen = new Set<string>();
  for (const s of scores) {
    if (!CODE_SET.has(s.styleCode)) problems.push(`非法风格代码: ${String(s.styleCode)}`);
    else if (seen.has(s.styleCode)) problems.push(`风格代码重复: ${s.styleCode}`);
    seen.add(s.styleCode);
    if (typeof s.probability !== "number" || !Number.isFinite(s.probability) || s.probability < 0 || s.probability > 1) {
      problems.push(`${String(s.styleCode)} 的 probability 必须是 0~1 的有限数`);
    }
  }
  for (const c of STYLE_CODES) if (!seen.has(c)) problems.push(`缺少风格代码: ${c}`);
  if (problems.length > 0) return problems;

  const primaries = scores.filter(s => s.isPrimary === true);
  const secondaries = scores.filter(s => s.isSecondary === true);
  if (primaries.length !== 1) problems.push(`主型必须恰好 1 个，实际 ${primaries.length} 个`);
  if (secondaries.length > 1) problems.push(`次型最多 1 个，实际 ${secondaries.length} 个`);
  if (scores.some(s => s.isPrimary === true && s.isSecondary === true)) problems.push("同一型不能同时是主型和次型");
  if (problems.length > 0) return problems;

  const p = (s: StyleScoreInput) => roundProbability(s.probability);
  const primary = primaries[0];
  if (scores.some(s => p(s) > p(primary))) problems.push(`主型 ${primary.styleCode} 不是概率最高项`);
  if (secondaries.length === 1) {
    const secondary = secondaries[0];
    if (scores.some(s => s !== primary && p(s) > p(secondary))) problems.push(`次型 ${secondary.styleCode} 不是概率第二高项`);
  }
  return problems;
}

// PATCH /me 里的 13 型代码字段（null 表示清空）
//   primaryStyle / secondaryStyle / aspiredStylePrimary：单个 13 型代码
//   aspiredStyleSecondary / currentStyle / rejectedStyleCodes：单个 13 型代码，或不重复的 13 型代码数组（可为 []）
// 2026-10-08：补上偏好侧 4 个旧字段（03A Part E V0.3 第三节、第十一节第 2 步）。
//   这 4 个字段保留 13 型语义，12 个风格形象标签 id 只能写进 aspiredImageTags 等新字段，这里一律拒绝。
const SINGLE_CODE_FIELDS = ["primaryStyle", "secondaryStyle", "aspiredStylePrimary"] as const;
const CODE_OR_LIST_FIELDS = ["aspiredStyleSecondary", "currentStyle", "rejectedStyleCodes"] as const;

export function validateStyleCodePatch(patch: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
  const isCode = (v: unknown) => typeof v === "string" && CODE_SET.has(v);
  for (const key of SINGLE_CODE_FIELDS) {
    if (!has(key)) continue;
    const v = patch[key];
    if (v === null) continue;
    if (!isCode(v)) problems.push(`${key} 必须是 13 型代码（${STYLE_CODES.join(" / ")}）或 null，实际: ${JSON.stringify(v)}`);
  }
  for (const key of CODE_OR_LIST_FIELDS) {
    if (!has(key)) continue;
    const v = patch[key];
    if (v === null || isCode(v)) continue;
    if (Array.isArray(v) && v.every(isCode) && new Set(v).size === v.length) continue;
    problems.push(`${key} 必须是 13 型代码、不重复的 13 型代码数组或 null，实际: ${JSON.stringify(v)}`);
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════════
// 变更日志字段名（2026-10-05）
// 驼峰 → 下划线，数字段前也加下划线，与库列名一致：finalSeason25 → final_season_25。
// 2026-10-05 之前的旧写法只在大写字母前加下划线，把 finalSeason25 记成了 final_season25；
// 历史日志行不改，读取方用 normalizeChangeLogFieldName 把旧名称映射到列名，新旧记录按同一字段处理。
// ══════════════════════════════════════════════════════════════════

export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/([a-z])(\d)/g, "$1_$2");
}

const LEGACY_CHANGE_LOG_FIELD_NAMES: Record<string, string> = {
  final_season25: "final_season_25",
};

export function normalizeChangeLogFieldName(name: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_CHANGE_LOG_FIELD_NAMES, name)
    ? LEGACY_CHANGE_LOG_FIELD_NAMES[name]
    : name;
}
