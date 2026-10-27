# 迁移与工具脚本

| 脚本 | 作用 |
| --- | --- |
| `import-to-db.mjs` | 把已有作品的正文 / 账本 / 旧意见导入 `novel.db`（不改正文） |
| `migrate-book-0.7.mjs` | 把 0.6 作品迁移成 0.7 形态（默认 dry-run，`--apply` 才写盘） |
| `migrate-titles.mjs` | 把回目标题写进正文 `.txt` 首行 |
| `migrate.js` | 0.5.x 旧章节（`.md` + frontmatter）迁移到 0.6 / 0.7 形态（默认 dry-run，写前整本备份） |
| `repair-polluted-chapters.mjs` | 修复历史 bug 造成的稿件污染 |
| `preflight.mjs` | 只读体检：插件安装状态、残留试装名、数据格式 |
| `ui-smoke.mjs` / `ui-e2e.mjs` | 界面冒烟 / 端到端（依赖真实作品数据与无头 Chrome，不随发布运行） |
