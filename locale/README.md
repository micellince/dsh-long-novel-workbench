# 界面文案

- `zh.json` / `en.json`：工作台界面文案（`meta.title` / `meta.description`），由 DSH 的 locale 机制按当前界面语言读取。
- 新增语言：加一个同结构的 `<locale>.json`，并在 `package.json` 的 `exports` 里放行。
