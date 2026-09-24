# Changelogs

## 0.0.1

- 内置官方 Bang 编译器 wasm（上游 v0.22.6-7），base64 内嵌，完全离线编译 / 反编译 / 格式化 / lint / 标签码
- 语法高亮与代码补全（使用 Acode 自带 CodeMirror 实例与 languageData）
- Brotli + base32768 源码嵌入与还原，与 VSCode 插件双向互通
- 侧边栏面板 / 侧边按钮 / 8 个命令 / 保存自动编译
- CI：定时跟进上游发版并自动构建发布
