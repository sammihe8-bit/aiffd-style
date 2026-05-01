import { mysqlTable, int, varchar, text, timestamp, decimal, mysqlEnum, index, uniqueIndex } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").primaryKey().autoincrement(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 100 }),
  role: mysqlEnum("role", ["user", "stylist", "admin"]).default("user").notNull(),
  membershipTier: mysqlEnum("membership_tier", ["free", "basic", "premium", "vip"]).default("free").notNull(),
  membershipExpiresAt: timestamp("membership_expires_at"),
  isActive: int("is_active").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("email_idx").on(table.email),
]);

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
}, (table) => [
  index("user_id_idx").on(table.userId),
]);

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
}, (table) => [
  index("user_sub_idx").on(table.userId),
]);

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
}, (table) => [
  uniqueIndex("code_idx").on(table.code),
]);

export const refreshTokens = mysqlTable("refresh_tokens", {
  id: int("id").primaryKey().autoincrement(),
  userId: int("user_id").notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type StyleDiagnosis = typeof styleDiagnoses.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type StyleSystem = typeof styleSystems.$inferSelect;
