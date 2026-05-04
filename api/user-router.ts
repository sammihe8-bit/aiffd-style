// api/user-router.ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";

// 简单的密码哈希函数（如果没有bcryptjs）
async function hashPassword(password: string): Promise<string> {
  // 注意：生产环境应该使用 bcryptjs
  // 这里先用简单方式，后续替换
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "aiffd-salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export const userRouter = createRouter({
  //============================================
  // 用户注册
  //============================================
  register: publicQuery
    .input(
      z.object({
        phone: z.string().min(1, "请输入手机号"),
        email: z.string().email("请输入有效邮箱").optional(),
        password: z.string().min(6, "密码至少6位"),
        name: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // 检查手机号是否已注册
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.phone, input.phone))
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "该手机号已注册",
        });
      }

      // 密码加密
      const passwordHash = await hashPassword(input.password);

      // 创建用户
      const result = await db.insert(users).values({
        phone: input.phone,
        email: input.email || null,
        passwordHash,
        name: input.name || null,
        role: "consumer",
        isVip: false,
        vipLevel: "none",
      });

      const userId = Number(result[0].insertId);

      return {
        success: true,
        userId,
        message: "注册成功",
      };
    }),

  //============================================
  // 用户登录
  //============================================
  login: publicQuery
    .input(
      z.object({
        phone: z.string(),
        password: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // 查找用户
      const results = await db
        .select()
        .from(users)
        .where(eq(users.phone, input.phone))
        .limit(1);

      if (results.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "用户不存在",
        });
      }

      const user = results[0];

      // 验证密码
      const inputHash = await hashPassword(input.password);
      if (inputHash !== user.passwordHash) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "密码错误",
        });
      }

      // 生成简单token（生产环境应该用JWT）
      const token = btoa(`${user.id}:${Date.now()}`);

      return {
        success: true,
        token,
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          role: user.role,
          isVip: user.isVip,
        },
      };
    }),
});
