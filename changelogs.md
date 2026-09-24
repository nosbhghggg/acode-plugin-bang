# Changelogs

## 0.0.1

- 内置官方 Bang 编译器 wasm（上游 v0.22.6-7），base64 内嵌，完全离线编译 / 反编译 / 格式化 / lint / 标签码
- 内置上游 `mlog-decompiler`：暴力重建控制流（`do-while` / `while` / `if-else` / `break` / `gswitch`），按质量输出多个候选
- 内置官方 381 条代码片段（`upstream/snippets.json`），支持 `${1}` / `${1:默认}` 占位符与 Tab 跳转
- 高亮词表改为直接取自官方 TextMate 语法（`upstream/mdtlbl.tmLanguage.json`），补齐 `elif` / `take` / `setres` / `gwhile` / `skip` 等官方关键字，新增跨行块注释 `#* … *#` 与文档注释 `#** … *#`
- 补上 `commentTokens`（`#`）与括号自动闭合声明，Acode 里的注释快捷键对 `.mdtlbl` 生效
- 修正源码嵌入头写死的来源标记，改为插件真实 id + 版本
- Brotli + base32768 源码嵌入与还原，与 VSCode 插件双向互通
- 侧边栏面板 / 侧边按钮 / 9 个命令 / 保存自动编译
- CI：定时跟进上游发版并自动构建发布
