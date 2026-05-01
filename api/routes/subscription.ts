import { Router } from "express";
import { z } from "zod";
import { db } from "../../db";
import { subscriptions, users } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { authenticate, AuthRequest, requireRole } from "../middleware/auth";

const router = Router();

const subscribeSchema = z.object({
  tier: z.enum(["basic", "premium", "vip"]),
  months: z.number().int().min(1).max(12).default(1),
  paymentMethod: z.string().optional(),
  amount: z.number().positive().optional(),
});

router.post("/", authenticate, async (req: AuthRequest, res) => {
  try {
    const data = subscribeSchema.parse(req.body);
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + data.months);
    
    const result = await db.insert(subscriptions).values({
      userId: req.user!.id,
      tier: data.tier,
      status: "active",
      startDate,
      endDate,
      paymentMethod: data.paymentMethod || null,
      amount: data.amount !== undefined ? String(data.amount) : null,
      autoRenew: 1,
    });
    
    await db.update(users).set({ membershipTier: data.tier, membershipExpiresAt: endDate }).where(eq(users.id, req.user!.id));
    res.status(201).json({ message: "订阅成功", id: Number(result[0].insertId), tier: data.tier, startDate, endDate });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    res.status(500).json({ error: "订阅失败" });
  }
});

router.get("/my", authenticate, async (req: AuthRequest, res) => {
  try {
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, req.user!.id)).orderBy(desc(subscriptions.createdAt));
    res.json(subs);
  } catch (error) {
    res.status(500).json({ error: "获取订阅失败" });
  }
});

router.get("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const allSubs = await db.select().from(subscriptions).orderBy(desc(subscriptions.createdAt));
    res.json(allSubs);
  } catch (error) {
    res.status(500).json({ error: "获取订阅列表失败" });
  }
});

export default router;
