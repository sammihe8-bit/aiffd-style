-- 2026-10-18：同意记录写入后端（01A V1.1 第十二节）
-- 先在 TiDB SQL Editor 运行：SHOW TABLES LIKE 'user_consents';
--   A. 没有结果（表不存在）→ 只执行第一段 CREATE TABLE
--   B. 表已存在 → 只执行第二段的两条 ALTER（逐条运行）

-- ── A. 建表 ──
CREATE TABLE IF NOT EXISTS user_consents (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  age_and_research_ack BOOLEAN NOT NULL,
  privacy_ack BOOLEAN NOT NULL,
  photo_consent BOOLEAN NOT NULL,
  research_data_consent BOOLEAN NOT NULL,
  policy_version VARCHAR(30) NOT NULL,
  consented_at TIMESTAMP NULL,
  source ENUM('onboarding','local_backfill') NOT NULL DEFAULT 'onboarding',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── B. 表已存在时补列 ──
ALTER TABLE user_consents ADD COLUMN consented_at TIMESTAMP NULL AFTER policy_version;
ALTER TABLE user_consents ADD COLUMN source ENUM('onboarding','local_backfill') NOT NULL DEFAULT 'onboarding' AFTER consented_at;
