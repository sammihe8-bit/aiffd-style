import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import {
  fashionItems, fashionItemVariants, fashionItemFieldSources,
  fashionItemStyleFeatures, fashionItemStyleScores, fashionItemStyleTags,
  fashionItemMaterialAttributes, fashionVariantColorAttributes, fashionVariantColorIdentity,
} from "../../db/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { authenticate, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
function formatItemId(insertedId: number): string {
  return `AIFFD_ITEM_${String(insertedId).padStart(6, "0")}`;
}
function formatVariantId(insertedId: number): string {
  return `AIFFD_VARIANT_${String(insertedId).padStart(6, "0")}`;
}
function stringifyFieldValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const FIELD_SOURCE_METHODS = [
  "brand_source", "manual_operator", "stylist",
  "ai_image_analysis", "ai_text_analysis", "system_inference",
] as const;
const STYLE_SOURCE_METHODS = ["rule_engine", "ai_image_analysis", "ai_text_analysis", "stylist"] as const;
const STYLE_CODES = ["R", "TR", "SG", "G", "FG", "SC", "C", "DC", "SN", "N", "FN", "SD", "D"] as const;

const ITEM_PATCHABLE_FIELDS = [
  "brandName", "itemName", "sourceCategory", "category", "subcategory",
  "productUrl", "sourceSite", "status",
  "silhouette", "shoulderStructure", "waistStructure", "fit", "garmentLength",
  "neckline", "baseSleeveLength", "sleeveShape", "structureLevel", "lineQuality",
  "visualVolume", "decorationLevel", "visualFocus",
  "primaryStyle", "secondaryStyle", "styleConfidence",
] as const;

const VARIANT_PATCHABLE_FIELDS = [
  "sku", "colorNameSource", "sizeOptions", "price", "currency", "availability", "productUrl",
  "inheritsItemStyle", "overrideReason", "variantStyleVersion", "variantMaterialOverride",
] as const;

// GET /items —— 商品列表
const listQuerySchema = z.object({
  category: z.string().optional(),
  subcategory: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
router.get("/items", authenticate, async (req: AuthRequest, res) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const conditions = [];
    if (query.category) conditions.push(eq(fashionItems.category, query.category as any));
    if (query.subcategory) conditions.push(eq(fashionItems.subcategory, query.subcategory));
    conditions.push(eq(fashionItems.status, (query.status ?? "active") as any));

    const items = await db.select().from(fashionItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(fashionItems.createdAt))
      .limit(query.limit).offset(query.offset);

    res.json({ items, limit: query.limit, offset: query.offset });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("List fashion items error:", error);
    res.status(500).json({ error: "获取商品列表失败" });
  }
});

// GET /items/:itemId —— 单个商品完整详情
router.get("/items/:itemId", authenticate, async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const itemRows = await db.select().from(fashionItems).where(eq(fashionItems.itemId, itemId)).limit(1);
    if (itemRows.length === 0) return res.status(404).json({ error: "商品不存在" });
    const item = itemRows[0];

    const [variants, styleScores, styleTags, materialAttrs] = await Promise.all([
      db.select().from(fashionItemVariants).where(eq(fashionItemVariants.itemId, itemId)),
      db.select().from(fashionItemStyleScores).where(eq(fashionItemStyleScores.itemId, itemId)),
      db.select().from(fashionItemStyleTags).where(eq(fashionItemStyleTags.itemId, itemId)),
      db.select().from(fashionItemMaterialAttributes).where(eq(fashionItemMaterialAttributes.itemId, itemId)),
    ]);

    const variantIds = variants.map(v => v.variantId);
    const colorAttrsByVariant: Record<string, unknown> = {};
    const colorIdentityByVariant: Record<string, unknown> = {};
    for (const vId of variantIds) {
      const [colorAttr] = await db.select().from(fashionVariantColorAttributes)
        .where(eq(fashionVariantColorAttributes.variantId, vId)).limit(1);
      const [colorIdentity] = await db.select().from(fashionVariantColorIdentity)
        .where(eq(fashionVariantColorIdentity.variantId, vId)).limit(1);
      if (colorAttr) colorAttrsByVariant[vId] = colorAttr;
      if (colorIdentity) colorIdentityByVariant[vId] = colorIdentity;
    }

    res.json({
      item, variants, styleScores, styleTags, materialAttributes: materialAttrs,
      colorAttributesByVariant: colorAttrsByVariant,
      colorIdentityByVariant: colorIdentityByVariant,
    });
  } catch (error) {
    console.error("Get fashion item detail error:", error);
    res.status(500).json({ error: "获取商品详情失败" });
  }
});

// POST /items —— 新建商品
const createItemSchema = z.object({
  category: z.enum(["tops", "outerwear", "dresses", "bottoms", "one_piece", "shoes", "bags", "accessories"]),
  brandName: z.string().max(100).optional(),
  itemName: z.string().max(255).optional(),
  subcategory: z.string().max(50).optional(),
  sourceCategory: z.string().max(100).optional(),
  productUrl: z.string().max(500).optional(),
  sourceSite: z.string().max(100).optional(),
});
router.post("/items", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const data = createItemSchema.parse(req.body);
    const result = await db.insert(fashionItems).values({ ...data, itemId: "PENDING" });
    const insertedId = Number(result[0].insertId);
    const itemId = formatItemId(insertedId);
    await db.update(fashionItems).set({ itemId }).where(eq(fashionItems.id, insertedId));

    const created = await db.select().from(fashionItems).where(eq(fashionItems.id, insertedId)).limit(1);
    res.json({ message: "商品已创建", item: created[0] });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Create fashion item error:", error);
    res.status(500).json({ error: "创建商品失败" });
  }
});

// PATCH /items/:itemId —— 更新结构/风格字段，同步写字段溯源
const patchItemSchema = z.object({
  patch: z.record(z.any()),
  sourceMethod: z.enum(FIELD_SOURCE_METHODS),
  confidence: z.number().min(0).max(1).optional(),
  verifiedBy: z.string().max(50).optional(),
});
router.patch("/items/:itemId", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const { patch, sourceMethod, confidence, verifiedBy } = patchItemSchema.parse(req.body);

    const itemRows = await db.select().from(fashionItems).where(eq(fashionItems.itemId, itemId)).limit(1);
    if (itemRows.length === 0) return res.status(404).json({ error: "商品不存在" });
    const item = itemRows[0];

    const validKeys = Object.keys(patch).filter(k => (ITEM_PATCHABLE_FIELDS as readonly string[]).includes(k));
    if (validKeys.length === 0) return res.status(400).json({ error: "没有提供任何可更新的字段" });

    const updateData: Record<string, unknown> = {};
    const changedFields: { fieldName: string; value: string }[] = [];
    for (const key of validKeys) {
      const oldStr = stringifyFieldValue((item as Record<string, unknown>)[key]);
      const newStr = stringifyFieldValue(patch[key]);
      if (oldStr === newStr) continue;
      updateData[key] = patch[key];
      changedFields.push({ fieldName: toSnakeCase(key), value: newStr });
    }
    if (changedFields.length === 0) return res.json({ message: "没有字段发生变化", item });

    await db.update(fashionItems).set(updateData).where(eq(fashionItems.id, item.id));
    for (const f of changedFields) {
      await db.insert(fashionItemFieldSources).values({
        itemId, variantId: null, fieldName: f.fieldName, value: f.value,
        sourceMethod, confidence: confidence !== undefined ? String(confidence) : null,
        verifiedBy: verifiedBy ?? null,
      });
    }

    const updated = await db.select().from(fashionItems).where(eq(fashionItems.id, item.id)).limit(1);
    res.json({ message: `已更新 ${changedFields.length} 个字段`, item: updated[0] });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Patch fashion item error:", error);
    res.status(500).json({ error: "更新商品失败" });
  }
});
// POST /items/:itemId/variants —— 新建颜色/SKU 变体
const createVariantSchema = z.object({
  sku: z.string().max(100).optional(),
  colorNameSource: z.string().max(100).optional(),
  sizeOptions: z.array(z.string()).optional(),
  price: z.number().optional(),
  currency: z.string().length(3).optional(),
  availability: z.boolean().optional(),
  productUrl: z.string().max(500).optional(),
});
router.post("/items/:itemId/variants", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const itemRows = await db.select().from(fashionItems).where(eq(fashionItems.itemId, itemId)).limit(1);
    if (itemRows.length === 0) return res.status(404).json({ error: "商品不存在" });

    const data = createVariantSchema.parse(req.body);
    const result = await db.insert(fashionItemVariants).values({
      itemId, variantId: "PENDING",
      sku: data.sku, colorNameSource: data.colorNameSource,
      sizeOptions: data.sizeOptions ? JSON.stringify(data.sizeOptions) : null,
      price: data.price !== undefined ? String(data.price) : null,
      currency: data.currency, availability: data.availability, productUrl: data.productUrl,
    });
    const insertedId = Number(result[0].insertId);
    const variantId = formatVariantId(insertedId);
    await db.update(fashionItemVariants).set({ variantId }).where(eq(fashionItemVariants.id, insertedId));

    const created = await db.select().from(fashionItemVariants).where(eq(fashionItemVariants.id, insertedId)).limit(1);
    res.json({ message: "变体已创建", variant: created[0] });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Create fashion item variant error:", error);
    res.status(500).json({ error: "创建变体失败" });
  }
});

// PATCH /variants/:variantId —— 更新变体运营字段
router.patch("/variants/:variantId", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { variantId } = req.params;
    const variantRows = await db.select().from(fashionItemVariants).where(eq(fashionItemVariants.variantId, variantId)).limit(1);
    if (variantRows.length === 0) return res.status(404).json({ error: "变体不存在" });

    const patch = req.body.patch ?? {};
    const validKeys = Object.keys(patch).filter(k => (VARIANT_PATCHABLE_FIELDS as readonly string[]).includes(k));
    if (validKeys.length === 0) return res.status(400).json({ error: "没有提供任何可更新的字段" });

    const updateData: Record<string, unknown> = {};
    for (const key of validKeys) {
      updateData[key] = key === "sizeOptions" && Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key];
    }
    await db.update(fashionItemVariants).set(updateData).where(eq(fashionItemVariants.id, variantRows[0].id));

    const updated = await db.select().from(fashionItemVariants).where(eq(fashionItemVariants.id, variantRows[0].id)).limit(1);
    res.json({ message: "变体已更新", variant: updated[0] });
  } catch (error) {
    console.error("Patch fashion item variant error:", error);
    res.status(500).json({ error: "更新变体失败" });
  }
});

// POST /material-attributes —— upsert 材质属性（item 级或 variant 级）
const materialSchema = z.object({
  itemId: z.string(),
  variantId: z.string().optional(),
  primaryMaterial: z.string().max(50).optional(),
  secondaryMaterials: z.array(z.string()).optional(),
  materialPercentage: z.record(z.number()).optional(),
  materialSourceText: z.string().optional(),
  materialFamily: z.enum(["natural_fiber", "regenerated_fiber", "synthetic_fiber", "leather_fur", "denim", "technical", "mixed"]).optional(),
  textureLevel: z.string().optional(),
  sheenLevel: z.string().optional(),
  drapeLevel: z.string().optional(),
  thicknessLevel: z.string().optional(),
  stretchLevel: z.string().optional(),
  tactileSoftness: z.string().optional(),
  sourceMethod: z.enum(FIELD_SOURCE_METHODS),
  confidence: z.number().min(0).max(1).optional(),
});
router.post("/material-attributes", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const data = materialSchema.parse(req.body);
    const variantCond = data.variantId ? eq(fashionItemMaterialAttributes.variantId, data.variantId) : isNull(fashionItemMaterialAttributes.variantId);
    const existing = await db.select().from(fashionItemMaterialAttributes)
      .where(and(eq(fashionItemMaterialAttributes.itemId, data.itemId), variantCond)).limit(1);

    const row: Record<string, unknown> = {
      primaryMaterial: data.primaryMaterial,
      secondaryMaterials: data.secondaryMaterials ? JSON.stringify(data.secondaryMaterials) : undefined,
      materialPercentage: data.materialPercentage ? JSON.stringify(data.materialPercentage) : undefined,
      materialSourceText: data.materialSourceText,
      materialFamily: data.materialFamily, textureLevel: data.textureLevel, sheenLevel: data.sheenLevel,
      drapeLevel: data.drapeLevel, thicknessLevel: data.thicknessLevel, stretchLevel: data.stretchLevel,
      tactileSoftness: data.tactileSoftness,
    };
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);

    if (existing.length > 0) {
      await db.update(fashionItemMaterialAttributes).set(row).where(eq(fashionItemMaterialAttributes.id, existing[0].id));
    } else {
      await db.insert(fashionItemMaterialAttributes).values({ itemId: data.itemId, variantId: data.variantId ?? null, ...row } as any);
    }

    const fieldsToTrack = ["materialFamily", "textureLevel", "sheenLevel", "drapeLevel", "thicknessLevel", "stretchLevel", "tactileSoftness"] as const;
    for (const f of fieldsToTrack) {
      if (data[f] === undefined) continue;
      await db.insert(fashionItemFieldSources).values({
        itemId: data.itemId, variantId: data.variantId ?? null, fieldName: toSnakeCase(f), value: String(data[f]),
        sourceMethod: data.sourceMethod, confidence: data.confidence !== undefined ? String(data.confidence) : null,
      });
    }

    res.json({ message: "材质属性已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save material attributes error:", error);
    res.status(500).json({ error: "保存材质属性失败" });
  }
});

// POST /color-attributes —— upsert 原始色彩属性（variant 级）
const colorAttrSchema = z.object({
  variantId: z.string(),
  colorNameSource: z.string().max(100).optional(),
  dominantColor: z.string().max(50).optional(),
  secondaryColors: z.array(z.string()).optional(),
  accentColors: z.array(z.string()).optional(),
  patternType: z.string().optional(),
  colorCount: z.number().int().optional(),
  colorContrastLevel: z.string().optional(),
  colorTemperature: z.string().optional(),
  valueLevel: z.string().optional(),
  saturationLevel: z.string().optional(),
  neutralTendency: z.string().optional(),
  sourceMethod: z.enum(FIELD_SOURCE_METHODS),
  confidence: z.number().min(0).max(1).optional(),
});
router.post("/color-attributes", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const data = colorAttrSchema.parse(req.body);
    const variantRows = await db.select().from(fashionItemVariants).where(eq(fashionItemVariants.variantId, data.variantId)).limit(1);
    if (variantRows.length === 0) return res.status(404).json({ error: "变体不存在" });
    const itemId = variantRows[0].itemId;

    const existing = await db.select().from(fashionVariantColorAttributes)
      .where(eq(fashionVariantColorAttributes.variantId, data.variantId)).limit(1);

    const row: Record<string, unknown> = {
      colorNameSource: data.colorNameSource, dominantColor: data.dominantColor,
      secondaryColors: data.secondaryColors ? JSON.stringify(data.secondaryColors) : undefined,
      accentColors: data.accentColors ? JSON.stringify(data.accentColors) : undefined,
      patternType: data.patternType, colorCount: data.colorCount, colorContrastLevel: data.colorContrastLevel,
      colorTemperature: data.colorTemperature, valueLevel: data.valueLevel,
      saturationLevel: data.saturationLevel, neutralTendency: data.neutralTendency,
    };
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);

    if (existing.length > 0) {
      await db.update(fashionVariantColorAttributes).set(row).where(eq(fashionVariantColorAttributes.id, existing[0].id));
    } else {
      await db.insert(fashionVariantColorAttributes).values({ variantId: data.variantId, ...row } as any);
    }

    const fieldsToTrack = ["dominantColor", "colorTemperature", "valueLevel", "saturationLevel", "neutralTendency", "patternType"] as const;
    for (const f of fieldsToTrack) {
      if (data[f] === undefined) continue;
      await db.insert(fashionItemFieldSources).values({
        itemId, variantId: data.variantId, fieldName: toSnakeCase(f), value: String(data[f]),
        sourceMethod: data.sourceMethod, confidence: data.confidence !== undefined ? String(data.confidence) : null,
      });
    }

    res.json({ message: "色彩属性已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save color attributes error:", error);
    res.status(500).json({ error: "保存色彩属性失败" });
  }
});

// POST /color-identity —— upsert 派生色彩身份（variant 级）
const colorIdentitySchema = z.object({
  variantId: z.string(),
  seasonName: z.enum(["春", "夏", "长夏", "秋", "冬"]).optional(),
  seasonElement: z.enum(["木", "火", "土", "金", "水"]).optional(),
  elementName: z.enum(["木", "火", "土", "金", "水"]).optional(),
  finalSeason25: z.string().max(20).optional(),
  colorIdentityConfidence: z.number().min(0).max(1).optional(),
  colorEngineVersion: z.string().max(20).optional(),
});
router.post("/color-identity", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const data = colorIdentitySchema.parse(req.body);
    const existing = await db.select().from(fashionVariantColorIdentity)
      .where(eq(fashionVariantColorIdentity.variantId, data.variantId)).limit(1);

    const row: Record<string, unknown> = {
      seasonName: data.seasonName, seasonElement: data.seasonElement, elementName: data.elementName,
      finalSeason25: data.finalSeason25,
      colorIdentityConfidence: data.colorIdentityConfidence !== undefined ? String(data.colorIdentityConfidence) : undefined,
      colorEngineVersion: data.colorEngineVersion,
    };
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);

    if (existing.length > 0) {
      await db.update(fashionVariantColorIdentity).set(row).where(eq(fashionVariantColorIdentity.id, existing[0].id));
    } else {
      await db.insert(fashionVariantColorIdentity).values({ variantId: data.variantId, ...row } as any);
    }
    res.json({ message: "色彩身份已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save color identity error:", error);
    res.status(500).json({ error: "保存色彩身份失败" });
  }
});

// POST /items/:itemId/style-scores —— 整体替换 13 型适配概率分布
const styleScoresSchema = z.object({
  variantId: z.string().optional(),
  scores: z.array(z.object({
    styleCode: z.enum(STYLE_CODES),
    score: z.number().min(0).max(1),
    isPrimary: z.boolean().optional(),
    isSecondary: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    sourceMethod: z.enum(STYLE_SOURCE_METHODS),
    engineVersion: z.string().max(20).optional(),
  })),
});
router.post("/items/:itemId/style-scores", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const { variantId, scores } = styleScoresSchema.parse(req.body);

    const variantCond = variantId ? eq(fashionItemStyleScores.variantId, variantId) : isNull(fashionItemStyleScores.variantId);
    await db.delete(fashionItemStyleScores).where(and(eq(fashionItemStyleScores.itemId, itemId), variantCond));
    for (const s of scores) {
      await db.insert(fashionItemStyleScores).values({
        itemId, variantId: variantId ?? null, styleCode: s.styleCode, score: String(s.score),
        isPrimary: s.isPrimary ?? false, isSecondary: s.isSecondary ?? false,
        confidence: s.confidence !== undefined ? String(s.confidence) : null,
        sourceMethod: s.sourceMethod, engineVersion: s.engineVersion,
      });
    }

    if (!variantId) {
      const primary = scores.find(s => s.isPrimary);
      const secondary = scores.find(s => s.isSecondary);
      await db.update(fashionItems).set({
        primaryStyle: primary?.styleCode as any,
        secondaryStyle: secondary?.styleCode as any,
        styleConfidence: primary?.confidence !== undefined ? String(primary.confidence) : null,
      }).where(eq(fashionItems.itemId, itemId));
    }

    res.json({ message: "风格概率分布已更新", count: scores.length });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save style scores error:", error);
    res.status(500).json({ error: "保存风格概率失败" });
  }
});

// POST /items/:itemId/style-tags —— 整体替换可解释风格标签
const styleTagsSchema = z.object({
  tags: z.array(z.object({
    tagType: z.enum(["signature", "conflict"]),
    tagCode: z.string(),
  })),
});
router.post("/items/:itemId/style-tags", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const { tags } = styleTagsSchema.parse(req.body);

    await db.delete(fashionItemStyleTags).where(eq(fashionItemStyleTags.itemId, itemId));
    for (const t of tags) {
      await db.insert(fashionItemStyleTags).values({ itemId, tagType: t.tagType, tagCode: t.tagCode as any });
    }
    res.json({ message: "风格标签已更新", count: tags.length });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save style tags error:", error);
    res.status(500).json({ error: "保存风格标签失败" });
  }
});

// POST /items/:itemId/style-features —— upsert 风格特征向量（8 维连续值）
const styleFeaturesSchema = z.object({
  variantId: z.string().optional(),
  yinYangBalance: z.number().min(0).max(1).optional(),
  softness: z.number().min(0).max(1).optional(),
  sharpness: z.number().min(0).max(1).optional(),
  naturalness: z.number().min(0).max(1).optional(),
  classicBalance: z.number().min(0).max(1).optional(),
  playfulness: z.number().min(0).max(1).optional(),
  dramaLevel: z.number().min(0).max(1).optional(),
  romanticDetail: z.number().min(0).max(1).optional(),
  sourceMethod: z.enum(STYLE_SOURCE_METHODS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  engineVersion: z.string().max(20).optional(),
});
router.post("/items/:itemId/style-features", authenticate, requireRole("admin"), async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const data = styleFeaturesSchema.parse(req.body);
    const variantCond = data.variantId ? eq(fashionItemStyleFeatures.variantId, data.variantId) : isNull(fashionItemStyleFeatures.variantId);
    const existing = await db.select().from(fashionItemStyleFeatures)
      .where(and(eq(fashionItemStyleFeatures.itemId, itemId), variantCond)).limit(1);

    const numFields = ["yinYangBalance", "softness", "sharpness", "naturalness", "classicBalance", "playfulness", "dramaLevel", "romanticDetail", "confidence"] as const;
    const row: Record<string, unknown> = { sourceMethod: data.sourceMethod, engineVersion: data.engineVersion };
    for (const f of numFields) if (data[f] !== undefined) row[f] = String(data[f]);
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);

    if (existing.length > 0) {
      await db.update(fashionItemStyleFeatures).set(row).where(eq(fashionItemStyleFeatures.id, existing[0].id));
    } else {
      await db.insert(fashionItemStyleFeatures).values({ itemId, variantId: data.variantId ?? null, ...row } as any);
    }
    res.json({ message: "风格特征向量已保存" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("Save style features error:", error);
    res.status(500).json({ error: "保存风格特征向量失败" });
  }
});

export default router;
