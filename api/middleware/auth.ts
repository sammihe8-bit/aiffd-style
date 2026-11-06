import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: { id: number; email: string | null; role: string; membershipTier: string };
}

// JWT_SECRET 必须由环境变量提供；没有配置、为空或等于仓库里出现过的默认值时，拒绝启动。
// 仓库是公开的，任何写在代码里的默认值都等于公开的签名密钥。
// 注意：只做检查，不 trim、不改写原值，避免线上已签发的 token 全部失效。
const PUBLIC_DEFAULT_SECRETS = ["aiffd-secret-key", "default-secret"];

function loadJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret === undefined || secret.trim() === "") {
    throw new Error("JWT_SECRET 未配置，拒绝启动。请在部署环境中设置 JWT_SECRET。");
  }
  if (PUBLIC_DEFAULT_SECRETS.includes(secret.trim())) {
    throw new Error("JWT_SECRET 等于公开仓库里出现过的默认值，拒绝启动。请更换为随机生成的密钥。");
  }
  return secret;
}

const JWT_SECRET = loadJwtSecret();

export function generateToken(userId: number, email: string | null, role: string, membershipTier: string) {
  return jwt.sign({ id: userId, email, role, membershipTier }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): any {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    // Only accept complete, expiring application identities, even when signed.
    if (typeof decoded !== "object" || decoded === null) return null;
    if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0) return null;
    if (!(decoded.email === null || typeof decoded.email === "string")) return null;
    if (!["user", "stylist", "admin"].includes(decoded.role)) return null;
    if (!["free", "basic", "premium", "vip"].includes(decoded.membershipTier)) return null;
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return null;
    return decoded;
  } catch { return null; }
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
