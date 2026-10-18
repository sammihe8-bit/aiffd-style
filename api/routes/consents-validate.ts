import { z } from "zod";

// ══════════════════════════════════════════════════════════════════
// 同意记录写入校验（纯函数，不访问数据库，可单独测试）
// 2026-10-18 新增：Onboarding 的 4 项授权写入 user_consents（01A V1.1 第十二节）
// ══════════════════════════════════════════════════════════════════

export const CONSENT_SOURCES = ["onboarding", "local_backfill"] as const;

// 允许的同意时间：不早于平台开始收集同意的日期，不晚于服务器当前时间 + 5 分钟（容忍设备时钟偏差）
const EARLIEST_CONSENT = Date.parse("2026-08-01T00:00:00Z");
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const consentInputSchema = z.object({
  ageAndResearchAck: z.literal(true, { errorMap: () => ({ message: "必须确认已满 18 岁并了解研究测试性质" }) }),
  privacyAck: z.literal(true, { errorMap: () => ({ message: "必须同意隐私政策" }) }),
  photoConsent: z.boolean(),
  researchDataConsent: z.boolean(),
  policyVersion: z.string().trim().min(1).max(30),
  source: z.enum(CONSENT_SOURCES).default("onboarding"),
  consentedAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.consentedAt === undefined) return;
  const t = Date.parse(v.consentedAt);
  if (t < EARLIEST_CONSENT || t > Date.now() + CLOCK_SKEW_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["consentedAt"], message: "consentedAt 超出合理范围" });
  }
});

export type ConsentInput = z.infer<typeof consentInputSchema>;

// onboarding：同意时间以服务器收到请求的时间为准，忽略客户端上报；
// local_backfill：没有服务器时间可用，只能采用浏览器本机记录里的时间（必须提供）
export function resolveConsentedAt(input: ConsentInput, now: Date): Date | null {
  if (input.source === "onboarding") return now;
  return input.consentedAt ? new Date(input.consentedAt) : null;
}
