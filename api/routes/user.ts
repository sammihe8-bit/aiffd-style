import { Router } from "express";
import { db } from "../../db";
import { users, subscriptions, styleDiagnoses } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, AuthRequest, requireRole } from "../middleware/auth";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "default-secret";

router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const userList = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (userList.length === 0) return res.status(404).json({ error: "用户不存在" });
    const user = userList[0];
    const subList = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)).orderBy(desc(subscriptions.createdAt));
    const diagnosisCount = await db.select().from(styleDiagnoses).where(eq(styleDiagnoses.userId, user.id));
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role, membershipTier: user.membershipTier, subscription: subList, diagnosisCount: diagnosisCount.length });
  } catch (error) {
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

// 更新个人资料（目前只支持改用户名 name；头像走前端本地预设方案，不经过这个接口）
const updateMeSchema = z.object({
  name: z.string().min(1, "用户名不能为空").max(50, "用户名最多50个字符"),
});
router.patch("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const { name } = updateMeSchema.parse(req.body);
    await db.update(users).set({ name }).where(eq(users.id, req.user!.id));
    res.json({
      message: "更新成功",
      user: { id: req.user!.id, name },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    console.error("更新用户资料错误:", error);
    res.status(500).json({ error: "更新失败" });
  }
});

router.get("/me/diagnoses", authenticate, async (req: AuthRequest, res) => {
  try {
    const diagnoses = await db.select().from(styleDiagnoses).where(eq(styleDiagnoses.userId, req.user!.id)).orderBy(desc(styleDiagnoses.createdAt));
    res.json(diagnoses);
  } catch (error) {
    res.status(500).json({ error: "获取诊断历史失败" });
  }
});

router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const allUsers = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, membershipTier: users.membershipTier }).from(users);
    res.json(allUsers);
  } catch (error) {
    res.status(500).json({ error: "获取用户列表失败" });
  }
});

// 用户注册
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: "密码至少6位" });
    }
    if (email) {
      const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        return res.status(400).json({ error: "该邮箱已被注册" });
      }
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const insertData: any = {
      passwordHash,
      role: "user",
      membershipTier: "free",
      isActive: 1,
    };
    if (email) insertData.email = email;
    if (name) insertData.name = name;
    if (phone) insertData.phone = phone;
    const result = await db.insert(users).values(insertData);
    const insertedId = Number(result[0].insertId);
    const token = jwt.sign(
      { id: insertedId, email: email || null, role: "user", membershipTier: "free" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      message: "注册成功",
      token,
      user: {
        id: insertedId,
        email: email || null,
        name: name || null,
        phone: phone || null,
        role: "user",
        membershipTier: "free",
      },
    });
  } catch (error: any) {
    console.error("注册错误:", error);
    res.status(500).json({ error: error.message || "注册失败" });
  }
});

export default router;
