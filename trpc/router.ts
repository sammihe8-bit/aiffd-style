import { initTRPC } from "@trpc/server";
import { z } from "zod";
import superjson from "superjson";
import { db } from "../db";
import { users, styleDiagnoses, styleSystems, subscriptions } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const t = initTRPC.create({
  transformer: superjson,
});
export const router = t.router;
export const publicProcedure = t.procedure;

const JWT_SECRET = process.env.JWT_SECRET || "default-secret";

function generateToken(userId: number, email: string, role: string, membershipTier: string) {
  return jwt.sign({ id: userId, email, role, membershipTier }, JWT_SECRET, { expiresIn: "7d" });
}

export const appRouter = router({
  health: publicProcedure.query(async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  user: router({
register: publicProcedure
.input(z.object({
  email: z.string().email("请输入有效邮箱").optional(),  // ← 加 .optional()
  password: z.string().min(6, "密码至少6位"),
  name: z.string().optional(),
  phone: z.string().optional(),
}))
  .mutation(async ({ input }) => {
// 如果提供了邮箱，检查是否已存在
if (email) {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    throw new Error("该邮箱已被注册");
  }
}
    if (existing.length > 0) {
      throw new Error("该邮箱已被注册");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.insert(users).values({
      email,
      passwordHash,
      name: name || null,
      role: "user",
      membershipTier: "free",
      isActive: 1,
    });
}), 
login: publicProcedure
  .input(z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    password: z.string().min(1),
  }))
  .mutation(async ({ input }) => {
    const { email, password, phone } = input;

    let userList;
    if (email) {
      userList = await db.select().from(users).where(eq(users.email, email)).limit(1);
    } else if (phone) {
      userList = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
    } else {
      throw new Error("请输入邮箱或手机号");
    }

    if (userList.length === 0) {
      throw new Error("邮箱或密码错误");
    }

    const user = userList[0];
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new Error("邮箱或密码错误");
    }

    if (!user.isActive) {
      throw new Error("账号已被禁用");
    }

    const token = generateToken(user.id, user.email, user.role, user.membershipTier);
    return {
      message: "登录成功",
      token,
      user: { 
        id: user.id, 
        phone: user.phone,
        email: user.email, 
        name: user.name, 
        role: user.role, 
        membershipTier: user.membershipTier || "free" 
      }
    };
  }),
  }),

  diagnosis: router({
    styles: publicProcedure.query(async () => {
      const styles = await db.select().from(styleSystems).where(eq(styleSystems.isActive, 1)).orderBy(styleSystems.sortOrder);
      return styles;
    }),

    save: publicProcedure
      .input(z.object({
        skinTone: z.string().optional(),
        seasonType: z.string().optional(),
        primaryStyle: z.string(),
        secondaryStyle: z.string().optional(),
        colorPalette: z.string().optional(),
        forbiddenColors: z.string().optional(),
        confidenceScore: z.number().min(0).max(1).optional(),
      }))
      .mutation(async ({ input }) => {
        return { message: "诊断保存功能需要登录" };
      }),

    my: publicProcedure.query(async () => {
      return { message: "需要登录" };
    }),
  }),

  subscription: router({
    my: publicProcedure.query(async () => {
      return { message: "需要登录" };
    }),
  }),
});

export type AppRouter = typeof appRouter;
// 强制重新部署 - 2026-05-04
