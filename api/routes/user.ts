import { Router } from "express";
import { db } from "../../db";
import { users, subscriptions, styleDiagnoses } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, AuthRequest, requireRole } from "../middleware/auth";

const router = Router();

router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const userList = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (userList.length === 0) return res.status(404).json({ error: "用户不存在" });
    
    const user = userList[0];
    const subList = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id)).orderBy(desc(subscriptions.createdAt)).limit(1);
    const diagnosisCount = await db.select().from(styleDiagnoses).where(eq(styleDiagnoses.userId, user.id));
    
    res.json({ id: user.id, email: user.email, name: user.name, role: user.role, membershipTier: user.membershipTier, subscription: subList[0] || null, diagnosisCount: diagnosisCount.length });
  } catch (error) {
    res.status(500).json({ error: "获取用户信息失败" });
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
    const allUsers = await db.select({ id: users.id, email: users.email, name: users.name, role: users.role, membershipTier: users.membershipTier, isActive: users.isActive, createdAt: users.createdAt }).from(users);
    res.json(allUsers);
  } catch (error) {
    res.status(500).json({ error: "获取用户列表失败" });
  }
});

export default router;
