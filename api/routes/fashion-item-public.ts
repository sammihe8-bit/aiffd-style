// ══════════════════════════════════════════════════════════════════
// 商品库对普通用户开放时的可见范围（2026-10-08）—— 纯函数，不访问数据库，可单独测试
//
// 商品库会对普通用户开放，但 GET /items、GET /items/:itemId 原来直接返回数据库整行，
// 包括风格分、形象标签评估、色彩身份、来源与置信度等内部标注，status 参数还能查到下架 / 归档商品。
// 规则：
//   admin    —— 与原来完全相同（整行 + 全部子表），可按任意 status 查询
//   其他角色 —— 只看 status = active 的商品；只返回下面白名单里的展示字段，不返回任何子表标注
//              列表传 status 且不是 active → 403；详情遇到非 active 商品按"商品不存在"返回 404（不暴露存在与否）
// 白名单采用"只放行列出的字段"：表里以后新增的列默认不对外，要公开须在这里显式加上。
// ══════════════════════════════════════════════════════════════════

export const PUBLIC_ITEM_STATUS = "active";

// 商品级：标识、品牌、名称、品类、购买链接
export const PUBLIC_ITEM_FIELDS = [
  "itemId", "brandName", "itemName", "category", "subcategory", "productUrl",
] as const;

// 变体级：颜色名、尺码、价格、库存、购买链接
export const PUBLIC_VARIANT_FIELDS = [
  "variantId", "colorNameSource", "sizeOptions", "price", "currency", "availability", "productUrl",
] as const;

export function isAdmin(role: unknown): boolean {
  return role === "admin";
}

function pick<K extends string>(row: Record<string, unknown>, fields: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const f of fields) out[f] = Object.prototype.hasOwnProperty.call(row, f) ? row[f] : null;
  return out;
}

export function toPublicItem(row: Record<string, unknown>) {
  return pick(row, PUBLIC_ITEM_FIELDS);
}

export function toPublicVariant(row: Record<string, unknown>) {
  return pick(row, PUBLIC_VARIANT_FIELDS);
}

// 列表查询的 status：admin 原样（默认 active）；其他角色只能是 active，传了别的值返回错误信息
export function resolveListStatus(role: unknown, requested: string | undefined):
  { status: string } | { error: string } {
  if (isAdmin(role)) return { status: requested ?? PUBLIC_ITEM_STATUS };
  if (requested !== undefined && requested !== PUBLIC_ITEM_STATUS) {
    return { error: "只有管理员可以查看未上架的商品" };
  }
  return { status: PUBLIC_ITEM_STATUS };
}

// 详情：非 admin 只能看 active 商品
export function canViewItem(role: unknown, itemStatus: unknown): boolean {
  return isAdmin(role) || itemStatus === PUBLIC_ITEM_STATUS;
}
