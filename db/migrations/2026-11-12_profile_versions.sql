-- 2026-11-12：档案版本快照表（01A V1.1 待建项）
-- 在 TiDB SQL Editor 里先选中 aiffd_style 数据库（或保留下面的库名前缀），运行这一条即可。
-- 已有的档案不需要手动补数据：每个档案下一次发生变化时，后端会先补存一份“变化前”的 baseline 快照。

CREATE TABLE IF NOT EXISTS aiffd_style.profile_versions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  profile_id VARCHAR(30) NOT NULL,
  profile_version INT NOT NULL,
  snapshot_kind ENUM('revision','baseline') NOT NULL DEFAULT 'revision',
  snapshot JSON NOT NULL,
  source ENUM('body_test','face_test','color_test','fashion_preference_test','user_manual_edit','behavior_tracking','feedback_submission','stylist_correction','quarterly_retest','ai_reassessment') NULL,
  changed_by_user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_profile_version (profile_id, profile_version)
);
