-- 2026-10-16：气血成为正式档案维度；测试进度表增加五季、五行副气两种类型
-- 二选一执行：
--   A. 在本仓库运行 npm run db:push（drizzle-kit 会按 db/schema.ts 自动生成同样的变更）
--   B. 在 TiDB 控制台逐条执行下面三条 ALTER 语句
-- 这几条 ALTER 都只是新增列或在 ENUM 末尾追加取值，不改动已有数据。

-- TiDB 不支持在同一条 ALTER 里让第二列 AFTER 第一列新加的列，所以拆成两条
ALTER TABLE human_style_profiles
  ADD COLUMN qixue_state ENUM('阴','阴多阳少','阴阳和谐','阴少阳多','阳') NULL AFTER style_element;

ALTER TABLE human_style_profiles
  ADD COLUMN qixue_answers TEXT NULL AFTER qixue_state;

ALTER TABLE test_progress
  MODIFY COLUMN test_type ENUM('body','style','color','fashion','color_season','color_element') NOT NULL;
