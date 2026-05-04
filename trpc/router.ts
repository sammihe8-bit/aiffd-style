import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { db } from "../db";
import { users, styleDiagnoses, styleSystems, subscriptions } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const t = initTRPC.create();

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
    email: z.string().email("请输入有效邮箱"),  // ← 改回必填
    password: z.string().min(6, "密码至少6位"),
    name: z.string().optional(),
    phone: z.string().optional(),              // ← 手机号可选
  }))
  .mutation(async ({ input }) => {
    const { email, password, name, phone } = input;

    // 检查邮箱是否已存在
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    
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

    const userId = Number(result[0].insertId);
    const token = generateToken(userId, email, "user", "free");

    return {
      message: "注册成功",
      token,
      user: { 
        id: userId, 
        email, 
        name: name || null, 
        role: "user", 
        membershipTier: "free" 
      }
    };
  }),
    });
login: publicProcedure
  .input(z.object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    password: z.string().min(1),
  }))
  .mutation(async ({ input }) => {        // ← 添加这一行！
    const { email, password, phone } = input;

    // 优先用邮箱查找，如果没有邮箱则用手机号
    let userList;
    if (email) {
      userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    } else if (phone) {
      userList = await db
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);
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

    const token = generateToken(user.id, user.email || user.phone, user.role, user.membershipTier || "free");
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
  }),                                    // ← 确保有闭合
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

    const token = generateToken(user.id, user.email || user.phone, user.role, user.membershipTier || "free");
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
  }),                                    // ← 确保有闭合
    }

    const user = userList[0];
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new Error("邮箱或密码错误");
    }

    if (!user.isActive) {
      throw new Error("账号已被禁用");
    }

    const token = generateToken(user.id, user.email || user.phone, user.role, user.membershipTier || "free");
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
        const { email, password } = input;
        const userList = await db.select().from(users).where(eq(users.email, email)).limit(1);
        
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
          user: { id: user.id, email: user.email, name: user.name, role: user.role, membershipTier: user.membershipTier }
        };
      }),

    profile: publicProcedure.query(async () => {
      return { message: "需要认证" };
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
