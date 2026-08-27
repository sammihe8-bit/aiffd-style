import { mysqlTable, int, varchar, text, timestamp, decimal, mysqlEnum } from "drizzle-orm/mysql-core";

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

// 2026-08-27 新增：测试进度存档，支撑"续测提醒"功能
// 每个用户 + 每种测试类型（body/style/color/fashion）只保留最新一条记录（upsert，见 test-progress 路由）
export const testProgress = mysqlTable("test_progress", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  testType: mysqlEnum("test_type", ["body", "style", "color", "fashion"]).notNull(),
  status: mysqlEnum("status", ["in_progress", "completed"]).notNull(),
  dataJson: text("data_json").notNull(), // 完整快照：当前所在题目位置 + 所有已答的答案，JSON.stringify 存
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
