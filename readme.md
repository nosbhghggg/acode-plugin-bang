# acode-plugin-bang

Acode 编辑器的 [Bang 语言](https://github.com/A4-Tacks/mindustry_logic_bang_lang)（mindustry_logic_bang_lang）开发插件。
**完全离线可用**——内置官方编译器的 WebAssembly 构建，手机上无需电脑、无需网络即可把 Bang 源码编译成 Mindustry mlog。

## 功能

- **语法高亮**：基于 Acode 自带 CodeMirror 实例的 StreamLanguage（注释 / 字符串 / 数字 / 关键字 / mlog 指令 / `@` 内置变量 / 宏 / 标签）
- **代码补全**：通过 CodeMirror languageData 提供——mlog 指令、控制流关键字、`@unit` 等内置变量、`For!` / `CountLoop!` 等片段
- **离线编译**：内置 bang 官方编译器 wasm（上游 v0.22.6），支持全部模式（编译 `c`、反编译 `r`、格式化 `i`、标签码 `t/T`、lint `l` 等）
- **反编译**：`.mlog` / `.logic` → Bang 源码
- **Brotli + base32768 源码嵌入**：编译产物末尾追加源码，游戏内复制后随时还原；与配套的
  [VSCode 插件](https://github.com/nosbhghggg/mindustry-logic-bang-language-runner) 双向互通
- **保存自动编译**：保存 `.mdtlbl` 时自动更新同名 `.logic`，并提示编译错误
- **三种入口**：侧边栏 Bang 面板 / 编辑器侧边按钮 / 命令面板（共 8 个命令，含「自检」诊断）

## 安装（用户）

1. 从 Release 下载 `plugin.zip`
2. Acode → 插件管理 → 右上角 `+` → **Local** → 选中该 zip 安装
3. 重启 Acode，打开任意 `.mdtlbl` 文件，看到顶部提示「Bang 插件已加载」即成功

更详细的用法见 [使用说明.md](./使用说明.md)。

## 目录结构

```
src/
  main.ts                 插件入口：命令、侧边栏面板、侧边按钮、保存钩子
  lang/
    bang-mode.ts          StreamLanguage 定义（使用 Acode 自带 CodeMirror 实例）
    bang-complete.ts      补全源（languageData）
  bang-core/
    compiler-wasm.ts      wasm 编译器驱动（base64 内嵌，零 fetch）
    embed.ts              Brotli + base32768 源码嵌入 / 还原
  wasm/                   wasm-bindgen 生成的胶水（构建产物，不入库）
  generated/              内嵌 base64 资源（构建产物，不入库）
compiler/
  bang-wasm/              上游 workspace 内的 wasm 壳 crate（构建时注入上游）
  upstream.json           锁定的上游 tag / 版本
tools/
  upgrade-compiler.mjs    本地一键升级：拉上游 → 编译 wasm → 生成胶水 → 内嵌
  gen-wasm-assets.mjs     生成 base64 内嵌资源
  sync-vendor.mjs         从 npm 同步 brotli-wasm 到 src/vendor
_test/all.cjs             回归测试：真实 CodeMirror 引擎 + 模拟 Acode 环境（22 项断言）
```

## 开发

```bash
npm ci
node tools/sync-vendor.mjs        # 同步 brotli 资源（src/vendor）
node tools/decode-assets.mjs      # 还原 icon.png（二进制资源以 base64 入库）
node tools/upgrade-compiler.mjs   # 首次需要：编译编译器 wasm + 生成胶水（需 Rust + wasm32 + wasm-bindgen-cli 0.2.128）
node tools/gen-wasm-assets.mjs    # 生成 base64 内嵌资源
npm run build                     # tsc 类型检查 + esbuild 打包 + 输出 plugin.zip
npm test                          # 回归测试
```

## 自动跟进上游

`.github/workflows/build.yml`：

- **每天定时**检查上游 `A4-Tacks/mindustry_logic_bang_lang` 最新 Release
- 有新版本 → 自动更新 `compiler/upstream.json` 并提交 → 触发构建
- **构建流程**：安装 Rust → 克隆上游对应 tag → 注入 `compiler/bang-wasm` → 编译 wasm →
  wasm-bindgen 生成胶水 → 同步 brotli → 生成内嵌资源 → 打包 → 跑回归测试 → 发布 Release（附 `plugin.zip`）
- 支持手动触发（`workflow_dispatch`，可指定上游 tag）与 `repository_dispatch`（由上游 release 事件直接触发）

## 实现要点（踩过的坑）

- 语言扩展**必须**返回带 `language` 字段的 `LanguageSupport`——Acode 用 `"language" in ext` 取解析器
- 必须使用 **Acode 自带的 CodeMirror 实例**（`acode.require("@codemirror/language")`）：
  插件自带 `@codemirror/state` 会因 CM6 的 `instanceof` 校验抛
  "Unrecognized extension value ... multiple instances"
- 补全走 **languageData**（Acode 已全局启用 autocompletion），不要自插补全扩展
- 剪贴板用 `cordova.plugins.clipboard.copy/paste`——Acode 没有 `clipboard` 模块
- 打开输出文件用 `editorManager.openFile(uri)`（不存在 `newFile`）；文件路径字段是 `file.uri` / `file.location`
- loader 用法是 `loader.create(title)` / `loader.destroy()`
- 插件命令默认 `requiresView: true`，需要无编辑器也能用时显式设为 `false`
- wasm 以 base64 内嵌：真机插件目录是 `cdvfile://` 协议，`fetch` 不可靠

## 许可证

GPL-3.0 —— 插件内嵌了 GPL-3.0 的 bang 官方编译器（上游 A4-Tacks/mindustry_logic_bang_lang）的 wasm 产物。
