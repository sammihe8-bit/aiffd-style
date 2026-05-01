import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: { id: number; email: string; role: string; membershipTier: string };
}

const JWT_SECRET = process.env.JWT_SECRET || "aiffd-secret-key";

export function generateToken(userId: number, email: string, role: string, membershipTier: string): string {
  return jwt.sign({ id: userId, email, role, membershipTier }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): any {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "未提供认证令牌" });
  }
  const decoded = verifyToken(authHeader.substring(7));
  if (!decoded) return res.status(401).json({ error: "令牌无效" });
  req.user = decoded;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "未认证" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "权限不足" });
    next();
  };
}
