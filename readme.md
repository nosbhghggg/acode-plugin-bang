# acode-plugin-bang

**Acode 的 [Bang 语言](https://github.com/A4-Tacks/mindustry_logic_bang_lang)（mindustry_logic_bang_lang）开发插件，完全离线可用。**

内置官方编译器的 WebAssembly 构建，手机上不联网、不接电脑，就能把 Bang 源码编译成 Mindustry mlog、把 mlog 反编译回 Bang、把一团 `jump` 重建回结构化控制流。

<p>
<img src="https://img.shields.io/github/v/release/nosbhghggg/acode-plugin-bang?style=flat-square&label=release&color=lightgrey" alt="release">
<img src="https://img.shields.io/github/license/nosbhghggg/acode-plugin-bang?style=flat-square&color=lightgrey" alt="license">
<img src="https://img.shields.io/github/last-commit/nosbhghggg/acode-plugin-bang?style=flat-square&color=lightgrey" alt="last-commit">
<img src="https://img.shields.io/github/languages/top/nosbhghggg/acode-plugin-bang?style=flat-square&color=lightgrey" alt="language">
</p>

<details>
<summary>目录</summary>

- [为什么做这个](#为什么做这个)
- [功能特性](#功能特性)
- [安装](#安装)
- [使用](#使用)
- [技术架构](#技术架构)
- [本地开发](#本地开发)
- [自动跟进上游](#自动跟进上游)
- [实现要点（踩过的坑）](#实现要点踩过的坑)
- [已知边界](#已知边界)
- [许可证](#许可证)

</details>

---

## 为什么做这个

> 在手机上写 Mindustry 逻辑，过去只有两条路：要么用游戏自带的图形化逻辑编辑器硬拖，要么等回到电脑前用 VSCode 写 Bang。Bang 官方只提供 CLI 与 Rust 库，安卓端是空白。
>
> 这个插件把官方编译器编进 WebAssembly 塞进 Acode，让「写 → 编译 → 进游戏」整条链路在手机上闭环，并且通过 GitHub Actions 每天自动跟进上游发版。

---

## 功能特性

- **语法高亮**：注释（含 `#* … *#` 跨行块注释与 `#** … *#` 文档注释）/ 字符串 / 数字 / 关键字 / mlog 指令 / `@` 内置变量 / 宏 / 标签。**词表直接取自官方 TextMate 语法**，与 VSCode 官方扩展一致
- **代码补全**：三层叠加——移植官方 `bangls` 补全算法（上下文感知的作用域变量、常量、`Builtin`）+ **内置官方 381 条代码片段**（支持 `${1}` / `${1:默认}` 占位符与 Tab 跳转）+ 指令 / 关键字 / 内置变量兜底
- **离线编译**：内置官方编译器 wasm（上游 v0.22.6-7），支持全部模式——编译 `c`、反编译 `r`、格式化 `i`、标签码 `t`/`T`、lint `l` 等
- **反编译**：`.mlog` / `.logic` → Bang 源码
- **控制流重建**：内置上游 `mlog-decompiler`，把一堆 `jump` / `@counter` 启发式归约成 `do-while` / `while` / `if-else` / `break` / `gswitch`，按质量排序输出多个候选
- **源码嵌入**：Brotli + base32768 把 Bang 源码压缩后写进编译产物末尾，游戏里复制出来就能还原源码；与配套的 [VSCode 插件](https://github.com/nosbhghggg/mindustry-logic-bang-language-runner) 双向互通
- **保存自动编译**：保存 `.mdtlbl` 时自动更新同名 `.logic`，编译错误当场提示
- **三种入口**：侧边栏面板 / 编辑器侧边按钮 / 命令面板（9 个命令，含「自检」诊断）

---

## 安装

1. 从 [Releases](https://github.com/nosbhghggg/acode-plugin-bang/releases) 下载 `plugin.zip`
2. Acode → 插件管理 → 右上角 `+` → **Local** → 选中该 zip
3. 确认插件已启用，建议重启一次 Acode
4. 打开任意 `.mdtlbl` 文件，顶部出现「Bang 插件已加载」提示即成功

要求 Acode `minVersionCode >= 290`（侧边悬浮按钮需 v316+）。

---

## 使用

### 文件类型

| 文件类型 | 是什么 | 插件能力 |
|---|---|---|
| `.mdtlbl` | Bang 源码（你写的） | 高亮、补全、编译成 mlog、保存自动查错 |
| `.mlog` / `.logic` | Mindustry 逻辑指令（游戏能跑的） | 高亮、反编译回 Bang、重建控制流、格式化 |

### 最短路径：写代码 → 进游戏

1. 新建 `test.mdtlbl`，写 Bang 代码：

   ```
   i = 0; do {
       x, y = cos(i)*r, sin(i)*r;
   } while ++i < 360;
   ```

2. 点编辑器右侧的 **Bang** 悬浮按钮 → 「复制 mlog 到剪贴板」
3. 切到 Mindustry → 逻辑处理器 → 编辑 → **Import from Clipboard**
4. 完成

保存 `.mdtlbl` 时插件会自动编译：成功则更新同目录同名 `.logic` 并提示行数，失败则提示「Bang 编译错误：xxx」。

### 菜单与命令

**在 `.mdtlbl`（源码）里**

| 菜单项 | 作用 |
|---|---|
| 编译并保存 .logic | 编译结果写到同目录 `.logic` |
| 编译并预览 | 开新窗口看结果，不落盘 |
| 查看标签码（t） | 输出带标签的中间形态，便于排查流程 |
| 复制 mlog 到剪贴板 | 最常用 |
| 从剪贴板导入 Bang 源码 | 从复制的 mlog 里还原源码 |

**在 `.mlog` / `.logic`（游戏指令）里**

| 菜单项 | 作用 |
|---|---|
| 反编译为 Bang 源码 | 把 mlog 变回 Bang |
| 重建控制流 | 只看跳转结构（循环 / 分支），见下节 |
| 格式化 mlog | 整理缩进与标签，原地替换 |
| 导入嵌入的 Bang 源码 | 若 mlog 里带源码，直接还原 |
| 从剪贴板导入 Bang 源码 | 同上，从剪贴板读 |

**命令面板**（搜 `Bang`）

```
Bang: 编译当前文件（mlog 输出到新文件）
Bang: 编译并复制 mlog 到剪贴板
Bang: 反编译当前 mlog 为 Bang 源码
Bang: 暴力重建 mlog 控制流（do-while / if-else / gswitch）
Bang: lint 检查当前文件
Bang: 导入 mlog 中嵌入的源码
Bang: 从剪贴板导入 Bang 源码
Bang: 切换「mlog 嵌入源码」开关
Bang: 自检（诊断插件状态）        ← 出问题先跑这个
```

### 控制流重建

**场景**：手里有一段从游戏导出或别人发的 mlog，只有一堆 `jump` 看不懂；想改成 Bang 的 `while` / `if`，但猜不出原作者意图。

打开 `.mlog` → 「重建控制流」，生成 `<原名>-flow.txt`：

```
# 控制流重建（暴力反编译）
# 来源：flow.mlog · 输入 5 行 · 迭代 2 轮 · 候选 2 个
# 按质量排序，loss 越小越好；标签为 定义数/引用数

# ---------- case 0 · loss 6.15000 · 标签 0/0 ----------
set i 0;
do {
    op add i i 1;
} while i < 8;
print i;
printflush message1;
```

- `jump` 被归约成 `do { } while`、`if { } else { }`、`while [ ]`、`break`、`gswitch case:`，`:_0` 形式的是跳转目标标签
- 同一段 mlog 往往有多种同样合理的结构解释，所以输出多个候选（默认 3 个），按成本 `loss` 升序——**`case 0` 通常就是原作者写的那种结构**
- 这是**启发式**结果，不是唯一正确答案；某个候选明显不对时往下看别的

**让结果更准**

- 无条件跳转必须写全三参数 **`jump L always 0 0`**。只写 `jump L` 或 `jump L always` 会被解析成「未知条件」，`if-else` / `while` 的归约会明显变差
- 长文件先「格式化 mlog」，再截取关心的片段重建，更快也更准

**注意**：输出是结构分析结果，不是可直接编译的 Bang 源码。要能直接编译的源码请用「反编译为 Bang 源码」。

### 源码嵌入

插件默认把 Bang **源码**一起打包写进编译产物末尾（`print ">DATA:…"` 那几行）。好处是**游戏里把 mlog 复制出来、粘回 Acode 就能还原完整源码**，手机上也能像桌面一样保源码往返。

- 与桌面 VSCode 插件互相兼容，哪边嵌的源码都能在另一边还原
- 关掉：命令面板执行 `Bang: 切换「mlog 嵌入源码」开关`
- 源码体积过大时会自动跳过嵌入，以保证 mlog 大小可用

### 补全不弹出？

补全走 Acode 的全局补全机制，需要在 **设置 → 编辑器 → 实时自动补全（liveAutoCompletion）** 打开；同时不要关闭「语言补全（languageCompletion）」，否则会连插件补全一起屏蔽。

---

## 技术架构

### 技术栈

| 技术 | 用途 |
|---|---|
| TypeScript | 插件主体语言 |
| esbuild | 打包（产出单文件 `main.js`） |
| CodeMirror 6 | 语法高亮与补全（**复用 Acode 自带实例**） |
| Rust / WebAssembly | 编译器与反编译内核，`wasm-bindgen` 生成胶水 |
| Rust（上游 workspace） | `parser` / `syntax` / `tag_code` / `logic_lint` 等官方语法与编译库 |
| brotli-wasm | 源码嵌入的 Brotli 压缩 |
| GitHub Actions | 跟进上游发版并自动构建发布 |

### 目录结构

```
src/
  main.ts                 插件入口：命令、侧边栏面板、侧边按钮、保存钩子
  lang/
    cm-modules.ts         共享的 CodeMirror 模块解析（优先 Acode 实例）
    bang-mode.ts          StreamLanguage 定义 + commentTokens / 括号声明
    bang-complete.ts      补全源（官方算法 + 官方片段 + 静态兜底）
    bang-snippets.generated.ts    官方 381 条片段          （生成物，入库）
    bang-tm-tokens.generated.ts   官方高亮词表             （生成物，入库）
  bang-core/
    compiler-wasm.ts      wasm 编译器驱动（base64 内嵌，零 fetch）
    embed.ts              Brotli + base32768 源码嵌入 / 还原
  wasm/                   wasm-bindgen 胶水              （构建产物，不入库）
  generated/              内嵌 base64 资源               （构建产物，不入库）
compiler/
  bang-wasm/              上游 workspace 内的 wasm 壳 crate（构建时注入上游）
    src/complete.rs       官方 LSP 补全算法移植（上游 tools/bangls）
    src/decompiler.rs     暴力反编译内核（vendored 上游 tools/decompiler）
    src/decompiler/       归约模式 / 损耗评估 / 结构化输出
  upstream.json           锁定的上游 tag / 版本
upstream/                 **上游产物冻结快照**（由 tools/sync-upstream.mjs 抓取并校验）
  SOURCE.json             上游 tag / commit / 每文件 sha256 / 二进制矩阵
  mdtlbl.tmLanguage.json  官方 TextMate 语法（高亮词表来源）
  snippets.json           官方 381 条代码片段
  language-configuration.json  官方注释 / 括号 / 缩进规则
tools/
  sync-upstream.mjs       抓上游产物 → 校 sha256 → 冻结到 upstream/
  gen-snippets.mjs        snippets.json → bang-snippets.generated.ts
  gen-tm-grammar.mjs      tmLanguage → bang-tm-tokens.generated.ts
  upgrade-compiler.mjs    本地一键升级：拉上游 → 编译 wasm → 生成胶水 → 内嵌
  gen-wasm-assets.mjs     生成 base64 内嵌资源
  sync-vendor.mjs         从 npm 同步 brotli-wasm 到 src/vendor
  decode-assets.mjs       还原 icon.png（二进制图标以 base64 入库）
_test/all.cjs             回归测试：真实 CodeMirror 引擎 + 模拟 Acode 环境（50 项断言）
```

### wasm 接口

```
compile(source, modes)                             按模式串转换（c / r / i / t / T / l …）
try_compile(source, modes)                         同上，但不抛异常，返回 {ok,output,error}
complete(source, byte_index)                       官方补全，返回候选 JSON 数组
decompile_mlog(source, iterations, limit, out_limit, guidance)
                                                   控制流重建，返回 {ok,iterations,lines,candidates,cases}
lint(source)                                       lint 报告
version()                                          上游编译器版本 + 绑定壳版本
```

---

## 本地开发

### 环境要求

- Node.js 22+
- Rust stable + `wasm32-unknown-unknown` target
- `wasm-bindgen-cli`（版本需与 `Cargo.lock` 中的 `wasm-bindgen` 一致）
- 上游仓库 `A4-Tacks/mindustry_logic_bang_lang` 的本地克隆（默认取 `../mindustry_logic_bang_lang`，可用 `UPSTREAM_DIR` 覆盖）

### 构建

```bash
npm ci
node tools/sync-vendor.mjs        # 同步 brotli 资源到 src/vendor
node tools/decode-assets.mjs      # 还原 icon.png
node tools/upgrade-compiler.mjs   # 编译 wasm + 生成胶水（首次必需）
node tools/gen-wasm-assets.mjs    # 生成 base64 内嵌资源
npm run gen:upstream              # 同步上游产物快照 + 重生成片段/词表
npm run build                     # tsc 类型检查 + esbuild 打包 + 输出 plugin.zip
npm test                          # 回归测试
```

`tools/upgrade-compiler.mjs` 支持指定上游 tag（`node tools/upgrade-compiler.mjs v0.23.0`），
路径类环境变量：`UPSTREAM_DIR` / `RUST_BIN_DIR` / `WASM_BINDGEN` / `CARGO_TARGET_DIR`。

### 上游素材的日常维护

上游产物（语法、片段）以**冻结快照**方式内置在 `upstream/`，插件不改上游任何源码：

```bash
npm run check:upstream                      # 只校验快照 sha256 与 tag 一致性，不联网
npm run gen:upstream                        # 重新抓取 + 重生成派生 TS
node tools/sync-upstream.mjs --tag v0.23.0  # 升级到指定 tag（同时刷新 SOURCE.json 的哈希）
```

`sync-upstream.mjs` 会在 `upstream/SOURCE.json` 与 `compiler/upstream.json` 的 tag 不一致时报错——
两处 pin 的是同一份上游，必须同步升级，否则会出现「wasm 是新版、片段是旧版」的隐性漂移。

### 回归测试

`_test/all.cjs` 在模拟的 Acode 环境里跑**真实 CodeMirror 6 引擎**，覆盖六组：

- **A**：Acode API 符合性（命令注册、`requiresView`、钩子）
- **B**：真实 CM 引擎的 token 解析、高亮渲染、`commentTokens` / 括号声明、官方词表对齐、补全源挂载
- **C**：功能流程（编译、保存、反编译、源码嵌入往返、自检）
- **D / E**：官方补全（上下文感知）与控制流重建
- **F**：上游素材对接（快照哈希、生成物计数与可复现、片段并入补全）

---

## 自动跟进上游

`.github/workflows/build.yml`：

- **每天定时**检查上游最新 Release；有新版本则自动更新 `compiler/upstream.json` 并提交，随后在同一轮 job 里继续构建
- **构建流程**：装 Rust → 按 tag 克隆上游到 `upstream-src/` → 校验 `upstream/` 快照哈希与 tag → 注入 `compiler/bang-wasm` → 编译 wasm → `wasm-bindgen` 生成胶水 → 同步 brotli → 生成内嵌资源 → 重生成片段/词表 → 打包 → 跑回归测试 → 发 Release（附 `plugin.zip`）
- 支持手动触发（`workflow_dispatch`，可指定上游 tag）与 `repository_dispatch`

> 注意：仓库里的 `upstream/`（产物快照）与 CI 克隆出来的 `upstream-src/`（上游源码）是两个目录，不要混用。

---

## 实现要点（踩过的坑）

- 语言扩展**必须**返回带 `language` 字段的 `LanguageSupport`——Acode 用 `"language" in ext` 取解析器
- 必须使用 **Acode 自带的 CodeMirror 实例**（`acode.require("@codemirror/language")`）：插件自带 `@codemirror/state` 会因 CM6 的 `instanceof` 校验抛 "Unrecognized extension value ... multiple instances"
- 补全走 **languageData**（Acode 已全局启用 autocompletion），不要自插补全扩展
- **TextMate 语法不能直接在 CM6 用**（依赖 Oniguruma）：做法是只提取其中的词表（关键字 / 指令 / 字面运算符 / 常量）生成 TS，字符串、注释、标签、数字等结构规则用有状态的 `StreamLanguage` 手写。这样词表永远跟官方一致
- **VSCode 片段语法 ≠ CM6 片段语法**：`${1}` / `${1:默认}` 两者相同，但 VSCode 的裸 `$1` / `$0` CM6 不认（要补成 `${1}`），`\$` 这种字面美元转义在 CM6 里没有对应概念（要还原为 `$`）。转换在 `tools/gen-snippets.mjs` 里做
- `snippetCompletion` 的 `apply` 会往编辑器 appendConfig 一个 `StateField`，**只有用 Acode 的 CM 实例才安全**；拿不到时回退成「纯文本插入 + 光标落位」，牺牲 Tab 跳换换来不炸编辑器（见 `cm-modules.ts`）
- CI 里克隆上游的目录**不能**叫 `upstream`，会和仓库里的产物快照目录 `upstream/` 冲突，故用 `upstream-src/`
- 剪贴板用 `cordova.plugins.clipboard.copy/paste`——Acode 没有 `clipboard` 模块
- 打开输出文件用 `editorManager.openFile(uri)`（不存在 `newFile`）；路径字段是 `file.uri` / `file.location`
- loader 用法是 `loader.create(title)` / `loader.destroy()`
- 插件命令默认 `requiresView: true`，需要无编辑器也能用时显式设为 `false`
- wasm 以 base64 内嵌：真机插件目录是 `cdvfile://` 协议，`fetch` 不可靠
- 暴力反编译内核是 **源码搬入**（vendored）而非包依赖：上游 `tools/decompiler` 是独立 bin crate，CI 只注入 `compiler/bang-wasm`，取不到它。搬入时去掉了 `mimalloc` 全局分配器（wasm 无此物）与 CLI / 测试模块。**这是全仓库唯一「复制上游源码」的地方**，上游改了要手动同步

---

## 已知边界

- 编译与控制流重建完全离线，不联网、不需要电脑
- 暂不支持直接注入游戏（需后续版本 + Mindustry 的 MlogWatcher 模组）
- mlog 行内波浪线诊断尚未实现，目前是保存后在提示里报首行错误
- 控制流重建的迭代轮数与候选上限暂未开放界面调节，固定使用手机端默认值（12 轮 / 200 候选）
- 编译器 wasm 已实现全部 15 个模式（`c a A t T f F r C l i n L b p`），但界面目前只暴露其中 5 个（`c r i t l`）
- 官方 381 条片段里，若前缀与关键字同名（如 `if` / `while` / `set`），补全列表以**片段**优先，避免同名项重复
- `For!` / `CountLoop!` / `print` 三条片段是本仓库自备的，不在官方片段集内

---

## 许可证

**GPL-3.0**。插件**不修改上游任何源码**，只以内置方式对接其现成产物：

- `compiler/bang-wasm/` 是塞进上游 workspace 的独立壳 crate，其中 `src/complete.rs` 移植自上游 `tools/bangls`，
  `src/decompiler/` 为 `tools/decompiler` 的源码搬入
- `upstream/` 是上游官方 VSCode 扩展 `syntax/vscode/support/` 下三份产物的**冻结快照**（TextMate 语法、代码片段、语言配置），
  经 `tools/gen-*.mjs` 转换后供插件消费

上游项目：[A4-Tacks/mindustry_logic_bang_lang](https://github.com/A4-Tacks/mindustry_logic_bang_lang)（GPL-3.0）
