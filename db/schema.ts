import { mysqlTable, int, varchar, text, timestamp, decimal, mysqlEnum, boolean } from "drizzle-orm/mysql-core";

// ══════════════════════════════════════════════════════════════════
// 原有表（未改动，来自现有 aiffd-style 仓库 db/schema.ts）
// ══════════════════════════════════════════════════════════════════

export const users = mysqlTable("users", {
  id: int("id").primaryKey().autoincrement(),
  email: varchar("email", { length: 255 }).unique(),
  phone: varchar("phone", { length: 20 }),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 100 }),
  role: mysqlEnum("role", ["user", "stylist", "admin"]).default("user").notNull(),
  membershipTier: mysqlEnum("membership_tier", ["free", "basic", "premium", "vip"]).default("free").notNull(),
  membershipExpiresAt: timestamp("membership_expires_at"),
  isActive: int("is_active").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const styleDiagnoses = mysqlTable("style_diagnoses", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  skinTone: varchar("skin_tone", { length: 50 }),
  seasonType: varchar("season_type", { length: 50 }),
  primaryStyle: varchar("primary_style", { length: 50 }).notNull(),
  secondaryStyle: varchar("secondary_style", { length: 50 }),
  colorPalette: text("color_palette"),
  forbiddenColors: text("forbidden_colors"),
  confidenceScore: decimal("confidence_score", { precision: 3, scale: 2 }),
  userFeedback: int("user_feedback"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const subscriptions = mysqlTable("subscriptions", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  tier: mysqlEnum("tier", ["free", "basic", "premium", "vip"]).notNull(),
  status: mysqlEnum("status", ["active", "expired", "cancelled", "pending"]).default("pending").notNull(),
  startDate: timestamp("start_date").defaultNow().notNull(),
  endDate: timestamp("end_date").notNull(),
  paymentMethod: varchar("payment_method", { length: 50 }),
  transactionId: varchar("transaction_id", { length: 255 }),
  amount: decimal("amount", { precision: 10, scale: 2 }),
  autoRenew: int("auto_renew").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const styleSystems = mysqlTable("style_systems", {
  id: int("id").primaryKey().autoincrement(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  nameEn: varchar("name_en", { length: 100 }),
  category: varchar("category", { length: 50 }).notNull(),
  description: text("description"),
  characteristics: text("characteristics"),
  bestColors: text("best_colors"),
  worstColors: text("worst_colors"),
  fabricSuggestions: text("fabric_suggestions"),
  patternSuggestions: text("pattern_suggestions"),
  accessorySuggestions: text("accessory_suggestions"),
  suitableBodyTypes: text("suitable_body_types"),
  suitableOccasions: text("suitable_occasions"),
  sortOrder: int("sort_order").default(0),
  isActive: int("is_active").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const refreshTokens = mysqlTable("refresh_tokens", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const testProgress = mysqlTable("test_progress", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  testType: mysqlEnum("test_type", ["body", "style", "color", "fashion"]).notNull(),
  status: mysqlEnum("status", ["in_progress", "completed"]).notNull(),
  dataJson: text("data_json").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type StyleDiagnosis = typeof styleDiagnoses.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type StyleSystem = typeof styleSystems.$inferSelect;
export type TestProgress = typeof testProgress.$inferSelect;
export type NewTestProgress = typeof testProgress.$inferInsert;

// ══════════════════════════════════════════════════════════════════
// 新增：Human Style Profile Database —— 对齐 Human Style Data Dictionary V1.0
// 2026-09-15 新增，8 张表
// ══════════════════════════════════════════════════════════════════

const CHANGE_SOURCES = [
  "body_test", "face_test", "color_test", "fashion_preference_test",
  "user_manual_edit", "behavior_tracking", "feedback_submission",
  "stylist_correction", "quarterly_retest", "ai_reassessment",
] as const;

// ── 表：活档案（Living Profile）────────────────────────────────────
export const humanStyleProfiles = mysqlTable("human_style_profiles", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull().unique(),
  profileId: varchar("profile_id", { length: 30 }).notNull().unique(),
  profileVersion: int("profile_version").default(1).notNull(),

  // 一、Identity
  ageRange: mysqlEnum("age_range", ["18-24", "25-34", "35-44", "45-54", "55+"]),
  heightRange: varchar("height_range", { length: 20 }),

  // 二、Body
  boneScale: mysqlEnum("bone_scale", ["S", "M", "L"]),
  boneRoundness: mysqlEnum("bone_roundness", ["圆", "匀", "角"]),
  boneWidth: mysqlEnum("bone_width", ["溜", "匀", "直"]),
  shoulderShape: mysqlEnum("shoulder_shape", ["rounded", "blunt_angular", "sharp_angular"]),
  waistType: text("waist_type"),
  waistLength: mysqlEnum("waist_length", ["短", "适中", "长"]),
  chestProtrude: mysqlEnum("chest_protrude", ["shallow", "moderate", "prominent", "uncertain"]),
  hipProtrude: mysqlEnum("hip_protrude", ["扁平", "适中", "圆翘"]),
  limbLength: mysqlEnum("limb_length", ["偏短", "适中", "偏长", "不确定"]),
  handFootSize: mysqlEnum("hand_foot_size", ["娇小", "适中", "偏大"]),
  bodyShape: mysqlEnum("body_shape", ["H型", "X型", "A型", "V型", "O型", "不确定"]),
  fleshTexture: mysqlEnum("flesh_texture", ["taut", "balanced", "soft", "uncertain"]),

  // 三、Face —— A. 原始观察字段
  mouthWidth: mysqlEnum("mouth_width", ["narrow", "balanced", "wide", "uncertain"]),
  mouthFullness: mysqlEnum("mouth_fullness", ["thin", "medium", "full", "uncertain"]),
  cheekContour: mysqlEnum("cheek_contour", ["round", "balanced", "angular", "uncertain"]),
  cheekFullness: mysqlEnum("cheek_fullness", ["full", "moderate", "lean", "uncertain"]),
  cheekboneProminence: mysqlEnum("cheekbone_prominence", ["low", "moderate", "prominent", "uncertain"]),
  cheekboneShape: mysqlEnum("cheekbone_shape", ["rounded", "balanced", "angular", "uncertain"]),
  chinLength: mysqlEnum("chin_length", ["short", "medium", "long", "uncertain"]),
  chinShape: mysqlEnum("chin_shape", ["round", "pointed", "square", "uncertain"]),
  eyeSize: mysqlEnum("eye_size", ["small", "medium", "large", "uncertain"]),
  eyeShape: mysqlEnum("eye_shape", ["round", "almond", "long", "uncertain"]),
  eyeSpacing: mysqlEnum("eye_spacing", ["close", "medium", "far", "uncertain"]),
  noseSize: mysqlEnum("nose_size", ["small", "medium", "large", "uncertain"]),
  noseShape: mysqlEnum("nose_shape", ["round", "balanced", "angular", "uncertain"]),
  noseProjection: mysqlEnum("nose_projection", ["flat", "medium", "prominent", "uncertain"]),
  jawline: varchar("jawline", { length: 50 }),
  faceLine: mysqlEnum("face_line", ["直线感", "曲线感", "混合"]),

  // 三、Face —— B. 算法汇总字段
  faceShape: mysqlEnum("face_shape", [
    "oval", "round", "square", "rectangular", "heart", "diamond", "triangular", "uncertain",
  ]),
  faceSharpnessLabel: mysqlEnum("face_sharpness_label", ["soft", "balanced", "angular"]),
  faceSharpnessScore: decimal("face_sharpness_score", { precision: 3, scale: 2 }),
  faceSharpnessConfidence: decimal("face_sharpness_confidence", { precision: 3, scale: 2 }),

  // 四、Style
  primaryStyle: varchar("primary_style", { length: 50 }),
  secondaryStyle: varchar("secondary_style", { length: 50 }),
  confidenceScore: decimal("confidence_score", { precision: 3, scale: 2 }),
  styleElement: mysqlEnum("style_element", ["木", "火", "土", "金", "水"]),

  // 五、Color
  skinTone: mysqlEnum("skin_tone", [
    "very_light", "light", "light_medium", "medium", "medium_deep", "deep", "uncertain",
  ]),
  hairColor: mysqlEnum("hair_color", [
    "black", "very_dark_brown", "dark_brown", "medium_brown", "light_brown",
    "blonde", "red_auburn", "gray_white", "dyed_other", "uncertain",
  ]),
  irisColor: mysqlEnum("iris_color", [
    "very_dark_brown", "dark_brown", "medium_brown", "light_brown_amber",
    "hazel", "green", "gray", "blue", "other", "uncertain",
  ]),
  warmCool: mysqlEnum("warm_cool", ["warm", "cool", "neutral_warm", "neutral_cool", "olive"]),
  valueLevel: mysqlEnum("value_level", ["高", "中", "低"]),
  saturationLevel: mysqlEnum("saturation_level", ["高", "中", "低"]),
  seasonName: mysqlEnum("season_name", ["春", "夏", "长夏", "秋", "冬"]),
  seasonElement: mysqlEnum("season_element", ["木", "火", "土", "金", "水"]),
  elementName: mysqlEnum("element_name", ["木", "火", "土", "金", "水"]),
  finalSeason25: varchar("final_season_25", { length: 20 }),

  // 六、Preference
  aspiredStylePrimary: varchar("aspired_style_primary", { length: 50 }),
  aspiredStyleSecondary: text("aspired_style_secondary"),
  currentStyle: text("current_style"),
  currentAspiredStyleGap: mysqlEnum("current_aspired_style_gap", ["stable", "gap", "no_fixed_style"]),
  rejectedStyleCodes: text("rejected_style_codes"),
  colorPreferences: text("color_preferences"),
  fabricPreferences: text("fabric_preferences"),

  // 七、Lifestyle（详见 profile_lifestyle_scenarios 子表）

  // 八、Budget
  budgetLevel: mysqlEnum("budget_level", ["B1", "B2", "B3", "B4", "B5"]),
  budgetMin: decimal("budget_min", { precision: 10, scale: 2 }),
  budgetMax: decimal("budget_max", { precision: 10, scale: 2 }),
  currency: varchar("currency", { length: 3 }).default("CNY").notNull(),
  priceSensitivity: mysqlEnum("price_sensitivity", ["高", "中", "低"]),

  // 九、Behavior（汇总缓存字段）
  viewCount: int("view_count").default(0).notNull(),
  favoriteCount: int("favorite_count").default(0).notNull(),
  clickCount: int("click_count").default(0).notNull(),
  externalClickCount: int("external_click_count").default(0).notNull(),
  purchaseCount: int("purchase_count").default(0).notNull(),
  lastActiveAt: timestamp("last_active_at"),

  // 十、Feedback（汇总缓存字段）
  outfitPhotoCount: int("outfit_photo_count").default(0).notNull(),
  avgSatisfactionScore: decimal("avg_satisfaction_score", { precision: 3, scale: 2 }),
  latestSelfRating: varchar("latest_self_rating", { length: 50 }),
  latestStylistRating: varchar("latest_stylist_rating", { length: 50 }),

  lastUpdatedSource: mysqlEnum("last_updated_source", CHANGE_SOURCES),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// ── 表：13 型风格概率分布 ───────────────────────────────────────
export const profileStyleScores = mysqlTable("profile_style_scores", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  styleCode: varchar("style_code", { length: 50 }).notNull(),
  probability: decimal("probability", { precision: 4, scale: 3 }).notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  isSecondary: boolean("is_secondary").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── 表：字段级变更日志 ──────────────────────────────────────────
export const profileFieldChangeLog = mysqlTable("profile_field_change_log", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  profileVersion: int("profile_version").notNull(),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value").notNull(),
  reason: varchar("reason", { length: 255 }),
  source: mysqlEnum("source", CHANGE_SOURCES).notNull(),
  changedByUserId: int("changed_by_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── 表：隐私同意记录 ────────────────────────────────────────────
export const userConsents = mysqlTable("user_consents", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  ageAndResearchAck: boolean("age_and_research_ack").notNull(),
  privacyAck: boolean("privacy_ack").notNull(),
  photoConsent: boolean("photo_consent").notNull(),
  researchDataConsent: boolean("research_data_consent").notNull(),
  policyVersion: varchar("policy_version", { length: 30 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── 表：生活场景权重 ────────────────────────────────────────────
export const profileLifestyleScenarios = mysqlTable("profile_lifestyle_scenarios", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  scenarioParent: mysqlEnum("scenario_parent", ["work", "social", "travel", "casual", "formal", "other"]).notNull(),
  scenarioType: mysqlEnum("scenario_type", ["predefined", "custom"]).notNull(),
  scenarioName: varchar("scenario_name", { length: 100 }),
  isFocus: boolean("is_focus").default(false).notNull(),
  weight: decimal("weight", { precision: 4, scale: 3 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// ── 表：单品偏好（P0）────────────────────────────────────────────
export const profileItemPreferences = mysqlTable("profile_item_preferences", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  itemType: varchar("item_type", { length: 50 }).notNull(),
  preferenceLevel: mysqlEnum("preference_level", ["like", "neutral", "dislike"]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// ── 表：视觉风格偏好（P0）────────────────────────────────────────
export const profileVisualStylePreferences = mysqlTable("profile_visual_style_preferences", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  visualStyleTag: varchar("visual_style_tag", { length: 50 }).notNull(),
  preferenceLevel: mysqlEnum("preference_level", ["like", "neutral", "dislike"]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
});

// ── 表：色彩原始信号观测记录 ────────────────────────────────────
export const profileColorSignals = mysqlTable("profile_color_signals", {
  id: int("id").primaryKey().autoincrement(),
  profileId: varchar("profile_id", { length: 30 }).notNull(),
  signalType: mysqlEnum("signal_type", ["skin_tone", "hair_color", "iris_color"]).notNull(),
  value: varchar("value", { length: 50 }).notNull(),
  sourceMethod: mysqlEnum("source_method", ["questionnaire", "ai_vision", "stylist_manual"]).notNull(),
  confidence: decimal("confidence", { precision: 3, scale: 2 }),
  observedAt: timestamp("observed_at").defaultNow().notNull(),
  isPrimary: boolean("is_primary").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type HumanStyleProfile = typeof humanStyleProfiles.$inferSelect;
export type NewHumanStyleProfile = typeof humanStyleProfiles.$inferInsert;
export type ProfileStyleScore = typeof profileStyleScores.$inferSelect;
export type ProfileFieldChangeLog = typeof profileFieldChangeLog.$inferSelect;
export type UserConsent = typeof userConsents.$inferSelect;
export type NewUserConsent = typeof userConsents.$inferInsert;
export type ProfileLifestyleScenario = typeof profileLifestyleScenarios.$inferSelect;
export type ProfileItemPreference = typeof profileItemPreferences.$inferSelect;
export type ProfileVisualStylePreference = typeof profileVisualStylePreferences.$inferSelect;
export type ProfileColorSignal = typeof profileColorSignals.$inferSelect;
