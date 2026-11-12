-- 2026-11-12：同意记录新增来源 profile_update（用户在「我的档案」里修改 / 撤回两项可选授权）
-- 在 TiDB SQL Editor 运行这一条（只在枚举末尾追加一个值，已有数据不受影响）：
ALTER TABLE aiffd_style.user_consents
  MODIFY COLUMN source ENUM('onboarding','local_backfill','profile_update') NOT NULL DEFAULT 'onboarding';
