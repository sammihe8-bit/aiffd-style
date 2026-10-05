import { IMAGE_TAGS } from "../../db/schema";

// ══════════════════════════════════════════════════════════════════
// 风格形象标签（12 个，Preference Fit 用）的写入校验 —— 纯函数，不访问数据库，可单独测试
// 2026-10-05 新增。人侧（PATCH /human-profile/me）与商品侧（POST /fashion-items/items/:itemId/image-tags）共用。
//
// 人侧 5 个字段（human_style_profiles）：
//   aspiredImageTags         Q1 理想形象，3～5 个
//   aspiredImageTagFavorite  Q1 标星，可空；必须在 aspiredImageTags 里
//   currentImageTags         Q2 实际常穿，0～3 个
//   currentImageStatus       selected（选了标签，至少 1 个）/ no_fixed_style（标签必须为空）
//   rejectedImageTags        Q3 明确不喜欢，0～12 个；不能与理想形象重叠
// 数组字段只接受 JSON 数组或 null（null = 清空 / 没做过测试；[] = 做了但没选）。
// 写库前按 IMAGE_TAGS 顺序排序，同一组选择不会因为提交顺序不同而产生多余的变更日志。
// ══════════════════════════════════════════════════════════════════

const TAG_SET = new Set<string>(IMAGE_TAGS);
const ORDER = new Map<string, number>(IMAGE_TAGS.map((t, i) => [t, i]));

export const PROFILE_IMAGE_TAG_FIELDS = [
  "aspiredImageTags", "aspiredImageTagFavorite", "currentImageTags", "currentImageStatus", "rejectedImageTags",
] as const;

const CURRENT_STATUSES = ["selected", "no_fixed_style"] as const;

export function canonicalOrder(tags: string[]): string[] {
  return [...tags].sort((a, b) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99));
}

// 库里存的是 JSON 字符串；读出来解析成数组。空值、坏数据、非数组都按 null 处理（不拿坏数据做交叉校验）
export function parseStoredTags(raw: unknown): string[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (Array.isArray(raw)) return raw.every(x => typeof x === "string") ? raw : null;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every(x => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}

function checkTagArray(field: string, v: unknown, min: number, max: number, problems: string[]): string[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) { problems.push(`${field} 必须是标签数组或 null`); return undefined; }
  const bad = v.filter(x => typeof x !== "string" || !TAG_SET.has(x));
  if (bad.length > 0) { problems.push(`${field} 含非法标签：${JSON.stringify(bad)}`); return undefined; }
  if (new Set(v).size !== v.length) { problems.push(`${field} 有重复标签`); return undefined; }
  if (v.length < min || v.length > max) { problems.push(`${field} 需要 ${min}～${max} 个标签，实际 ${v.length} 个`); return undefined; }
  return canonicalOrder(v as string[]);
}

type StoredProfile = {
  aspiredImageTags?: unknown; aspiredImageTagFavorite?: unknown;
  currentImageTags?: unknown; currentImageStatus?: unknown; rejectedImageTags?: unknown;
};

// patch 里没有这 5 个字段时直接通过、不做任何改动。
// 有其中任一字段时：逐字段校验，再用"提交后的完整状态"（patch 覆盖库里现值）做交叉校验。
// 返回 normalized：通过校验的字段（数组已排序），由调用方合并回 patch。
export function validateProfileImageTagPatch(patch: Record<string, unknown>, current: StoredProfile) {
  const problems: string[] = [];
  const normalized: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
  if (!PROFILE_IMAGE_TAG_FIELDS.some(has)) return { problems, normalized };

  if (has("aspiredImageTags")) {
    const r = checkTagArray("aspiredImageTags", patch.aspiredImageTags, 3, 5, problems);
    if (r !== undefined) normalized.aspiredImageTags = r;
  }
  if (has("currentImageTags")) {
    const r = checkTagArray("currentImageTags", patch.currentImageTags, 0, 3, problems);
    if (r !== undefined) normalized.currentImageTags = r;
  }
  if (has("rejectedImageTags")) {
    const r = checkTagArray("rejectedImageTags", patch.rejectedImageTags, 0, IMAGE_TAGS.length, problems);
    if (r !== undefined) normalized.rejectedImageTags = r;
  }
  if (has("aspiredImageTagFavorite")) {
    const v = patch.aspiredImageTagFavorite;
    if (v === null) normalized.aspiredImageTagFavorite = null;
    else if (typeof v === "string" && TAG_SET.has(v)) normalized.aspiredImageTagFavorite = v;
    else problems.push(`aspiredImageTagFavorite 必须是标签 id 或 null，实际 ${JSON.stringify(v)}`);
  }
  if (has("currentImageStatus")) {
    const v = patch.currentImageStatus;
    if (v === null || (typeof v === "string" && (CURRENT_STATUSES as readonly string[]).includes(v))) normalized.currentImageStatus = v;
    else problems.push(`currentImageStatus 必须是 selected / no_fixed_style 或 null，实际 ${JSON.stringify(v)}`);
  }
  if (problems.length > 0) return { problems, normalized: {} };

  // 提交后的完整状态
  const pick = <T>(k: string, stored: T) => (has(k) ? normalized[k] : stored) as T;
  const aspired = pick("aspiredImageTags", parseStoredTags(current.aspiredImageTags));
  const favorite = pick("aspiredImageTagFavorite", typeof current.aspiredImageTagFavorite === "string" ? current.aspiredImageTagFavorite : null);
  const currentTags = pick("currentImageTags", parseStoredTags(current.currentImageTags));
  const status = pick("currentImageStatus", typeof current.currentImageStatus === "string" ? current.currentImageStatus : null);
  const rejected = pick("rejectedImageTags", parseStoredTags(current.rejectedImageTags));

  if (favorite !== null && !(aspired ?? []).includes(favorite as string)) {
    problems.push("aspiredImageTagFavorite 必须是 aspiredImageTags 里的一个标签");
  }
  if ((currentTags === null) !== (status === null)) {
    problems.push("currentImageTags 与 currentImageStatus 必须同时有值或同时为空");
  } else if (status === "no_fixed_style" && (currentTags as string[]).length > 0) {
    problems.push("选择“没有固定风格”时 currentImageTags 必须为空数组");
  } else if (status === "selected" && (currentTags as string[]).length === 0) {
    problems.push("currentImageStatus 为 selected 时至少要有 1 个标签");
  }
  if (aspired && rejected) {
    const overlap = rejected.filter(t => aspired.includes(t));
    if (overlap.length > 0) problems.push(`同一标签不能既是理想形象又是排斥形象：${overlap.join(", ")}`);
  }
  return problems.length > 0 ? { problems, normalized: {} } : { problems, normalized };
}

// ── 商品侧标签评估 ───────────────────────────────────────────────
// score 0～1、最多两位小数（库里 decimal(3,2)）；人工标注建议只用 1.00 / 0.50 / 0.00 三档。
// 每个标签最多一行；没提交的标签 = 未评估（不当 0）。空数组 = 清空这件商品的全部评估。
export interface ItemImageTagInput {
  tagId: string;
  score: number;
  confidence?: number;
}

const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) / 100 - n) < 1e-9;

export function validateItemImageTags(tags: ItemImageTagInput[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(tags)) return ["tags 必须是数组"];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t?.tagId !== "string" || !TAG_SET.has(t.tagId)) { problems.push(`非法标签：${JSON.stringify(t?.tagId)}`); continue; }
    if (seen.has(t.tagId)) problems.push(`标签重复：${t.tagId}`);
    seen.add(t.tagId);
    if (typeof t.score !== "number" || !Number.isFinite(t.score) || t.score < 0 || t.score > 1 || !twoDecimals(t.score)) {
      problems.push(`${t.tagId} 的 score 必须是 0～1、最多两位小数，实际 ${JSON.stringify(t.score)}`);
    }
    if (t.confidence !== undefined &&
      (typeof t.confidence !== "number" || !Number.isFinite(t.confidence) || t.confidence < 0 || t.confidence > 1 || !twoDecimals(t.confidence))) {
      problems.push(`${t.tagId} 的 confidence 必须是 0～1、最多两位小数，实际 ${JSON.stringify(t.confidence)}`);
    }
  }
  return problems;
}
