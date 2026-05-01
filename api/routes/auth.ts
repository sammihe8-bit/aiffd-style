import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "../../db";
import { users, refreshTokens } from "../../db/schema";
import { eq } from "drizzle-orm";
import { generateToken } from "../middleware/auth";

const router = Router();

const registerSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(6, "密码至少6位"),
  name: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) return res.status(409).json({ error: "该邮箱已被注册" });
    
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.insert(users).values({ email, passwordHash, name: name || null });
    const userId = Number(result[0].insertId);
    const token = generateToken(userId, email, "user", "free");
    
    res.status(201).json({ message: "注册成功", token, user: { id: userId, email, name: name || null, role: "user", membershipTier: "free" } });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    res.status(500).json({ error: "注册失败" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const userList = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (userList.length === 0) return res.status(401).json({ error: "邮箱或密码错误" });
    
    const user = userList[0];
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return res.status(401).json({ error: "邮箱或密码错误" });
    if (!user.isActive) return res.status(403).json({ error: "账号已被禁用" });
    
    const token = generateToken(user.id, user.email, user.role, user.membershipTier);
    res.json({ message: "登录成功", token, user: { id: user.id, email: user.email, name: user.name, role: user.role, membershipTier: user.membershipTier } });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    res.status(500).json({ error: "登录失败" });
  }
});

export default router;
