import { IMAGE_SOURCE_TYPES, IMAGE_LICENSE_STATUSES } from "../../db/schema";

// ══════════════════════════════════════════════════════════════════
// 商品图片登记（2026-10-09）—— 纯函数，不访问数据库，可单独测试
//
// 第一阶段：图片由管理员在阿里云 OSS 控制台上传（Bucket aiffd-images，华北2 北京），
// 再通过 POST /api/fashion-item/items/:itemId/images 把地址整体登记到 fashion_item_images。
// 后端不持有 OSS 密钥，也不上传文件。
//
// 规则：
//   imageUrl     必须是 https 地址；同一商品内不重复
//   variantId    为空 = 整款通用；非空时必须是该商品自己的变体
//   sourceType   own_photo 自己拍 / brand_site 品牌官网
//   licenseStatus own_photo 只能是 owned；brand_site 只能是 authorized / link_only / unknown
//   link_only    未获授权、只存官网原链接：imageUrl 必须等于 sourceUrl（不复制到自己的存储）
//   isPrimary    同一范围（整款，或同一个变体）最多一张主图
//
// 普通用户可见范围：只返回 licenseStatus 为 owned / authorized / link_only 的图片，
// 字段只有 imageUrl、variantId、isPrimary、sortOrder、width、height；
// unknown（授权待确认）的图片只有 admin 看得到，避免未确认授权的图片被公开展示。
// ══════════════════════════════════════════════════════════════════

export const MAX_IMAGES_PER_ITEM = 30;
export const PUBLIC_LICENSE_STATUSES = ["owned", "authorized", "link_only"] as const;
export const PUBLIC_IMAGE_FIELDS = ["imageUrl", "variantId", "isPrimary", "sortOrder", "width", "height"] as const;

export interface ItemImageInput {
  imageUrl: string;
  variantId?: string | null;
  sourceType: string;
  sourceUrl?: string | null;
  licenseStatus?: string;
  isPrimary?: boolean;
  sortOrder?: number;
  width?: number | null;
  height?: number | null;
}

function isHttpsUrl(v: unknown, maxLen: number): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.length > 0;
  } catch {
    return false;
  }
}

const isPosInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100000;

export function validateItemImages(images: ItemImageInput[], itemVariantIds: string[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(images)) return ["images 必须是数组"];
  if (images.length > MAX_IMAGES_PER_ITEM) problems.push(`一件商品最多登记 ${MAX_IMAGES_PER_ITEM} 张图片，实际 ${images.length} 张`);

  const variantSet = new Set(itemVariantIds);
  const seenUrl = new Set<string>();
  const primaryScopes = new Map<string, number>();

  images.forEach((img, i) => {
    const at = `第 ${i + 1} 张`;
    if (!isHttpsUrl(img?.imageUrl, 500)) { problems.push(`${at}：imageUrl 必须是 https 地址，最长 500 字符`); return; }
    if (seenUrl.has(img.imageUrl)) problems.push(`${at}：imageUrl 重复 ${img.imageUrl}`);
    seenUrl.add(img.imageUrl);

    const variantId = img.variantId ?? null;
    if (variantId !== null && (typeof variantId !== "string" || !variantSet.has(variantId))) {
      problems.push(`${at}：variantId ${JSON.stringify(variantId)} 不是这件商品的变体`);
    }

    if (!(IMAGE_SOURCE_TYPES as readonly string[]).includes(img.sourceType)) {
      problems.push(`${at}：sourceType 必须是 ${IMAGE_SOURCE_TYPES.join(" / ")}`);
    }
    const license = img.licenseStatus ?? "unknown";
    if (!(IMAGE_LICENSE_STATUSES as readonly string[]).includes(license)) {
      problems.push(`${at}：licenseStatus 必须是 ${IMAGE_LICENSE_STATUSES.join(" / ")}`);
    } else if (img.sourceType === "own_photo" && license !== "owned") {
      problems.push(`${at}：自己拍的图片（own_photo）licenseStatus 只能是 owned`);
    } else if (img.sourceType === "brand_site" && license === "owned") {
      problems.push(`${at}：品牌官网图片（brand_site）licenseStatus 不能是 owned`);
    }

    const sourceUrl = img.sourceUrl ?? null;
    if (sourceUrl !== null && !isHttpsUrl(sourceUrl, 1000)) problems.push(`${at}：sourceUrl 必须是 https 地址，最长 1000 字符`);
    if (license === "link_only" && sourceUrl !== img.imageUrl) {
      problems.push(`${at}：link_only 表示只存官网原链接，imageUrl 必须与 sourceUrl 相同`);
    }

    if (img.isPrimary !== undefined && typeof img.isPrimary !== "boolean") problems.push(`${at}：isPrimary 必须是 true / false`);
    if (img.isPrimary === true) {
      const scope = variantId ?? "(整款)";
      primaryScopes.set(scope, (primaryScopes.get(scope) ?? 0) + 1);
    }
    if (img.sortOrder !== undefined && !(typeof img.sortOrder === "number" && Number.isInteger(img.sortOrder) && img.sortOrder >= 0 && img.sortOrder <= 9999)) {
      problems.push(`${at}：sortOrder 必须是 0～9999 的整数`);
    }
    for (const k of ["width", "height"] as const) {
      const v = img[k];
      if (v !== undefined && v !== null && !isPosInt(v)) problems.push(`${at}：${k} 必须是正整数`);
    }
  });

  for (const [scope, n] of primaryScopes) {
    if (n > 1) problems.push(`主图重复：${scope} 有 ${n} 张 isPrimary = true，最多 1 张`);
  }
  return problems;
}

// 排序：整款图在前；主图在前；再按 sortOrder、id
type ImageRow = Record<string, unknown> & { id?: unknown; variantId?: unknown; isPrimary?: unknown; sortOrder?: unknown };
export function sortImages<T extends ImageRow>(rows: T[]): T[] {
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  return [...rows].sort((a, b) =>
    (a.variantId ? 1 : 0) - (b.variantId ? 1 : 0) ||
    (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) ||
    num(a.sortOrder) - num(b.sortOrder) ||
    num(a.id) - num(b.id));
}

export function isPublicImage(row: Record<string, unknown>): boolean {
  return (PUBLIC_LICENSE_STATUSES as readonly string[]).includes(String(row.licenseStatus));
}

export function toPublicImage(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of PUBLIC_IMAGE_FIELDS) out[f] = Object.prototype.hasOwnProperty.call(row, f) ? row[f] : null;
  out.isPrimary = Boolean(out.isPrimary);
  return out;
}

// 列表卡片用的主图：整款主图优先；没有则取排序第一张整款图；再没有返回 null
export function pickPrimaryImageUrl(rows: ImageRow[], publicOnly: boolean): string | null {
  const pool = sortImages(rows.filter(r => !r.variantId && (!publicOnly || isPublicImage(r))));
  const first = pool[0];
  return first && typeof first.imageUrl === "string" ? first.imageUrl : null;
}
