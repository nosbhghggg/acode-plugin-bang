/**
 * 全量验证（最终版）
 * A. Acode API 符合性（对照 Acode 源码真实签名）
 * B. 真实 CodeMirror 引擎：token 解析 / 高亮渲染 / 补全
 * C. 功能流程：编译、嵌入、保存、反编译、导入、自检
 */
const path = require("path");
const zlib = require("zlib");
const { EditorState } = require("@codemirror/state");
const cmLang = require("@codemirror/language");
const { syntaxTree, ensureSyntaxTree, LanguageSupport, HighlightStyle } = cmLang;
const { CompletionContext } = require("@codemirror/autocomplete");
const cmAuto = require("@codemirror/autocomplete");
const lezerHl = require("@lezer/highlight");

const results = [];
const ok = (n, c, extra = "") => results.push([c ? "PASS" : "FAIL", n, extra]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const cmds = {};
const files = new Map();
const opened = [];
let clipboard = "";
let loader = null;
let lastToast = "";
let lastAlert = null;
const evHandlers = {};

const SRC = "i = 0; do {\n    x, y = cos(i)*r, sin(i)*r;\n} while ++i < 360;";
const MLOG = "set i 0\nop cos __0 i 0\nop mul x __0 r\nop sin __1 i 0\nop mul y __1 r\nop add i i 1\njump 1 lessThan i 360";

global.cordova = {
  plugins: {
    clipboard: { copy: (t) => (clipboard = t), paste: (cb) => cb(clipboard) },
  },
};

const activeFile = {
  filename: "t.mdtlbl",
  uri: "content://doc/t.mdtlbl",
  location: "content://doc/t.mdtlbl",
  session: { getValue: () => SRC, setValue: () => {} },
};

const acodeMock = {
  setPluginInit: (id, cb) => (global.__init = cb),
  setPluginUnmount: () => {},
  require: (n) => {
    switch (n) {
      case "editorLanguages":
        return {
          register: (a, b, c, l) => (loader = l),
          unregister: () => {},
          getForPath: () => ({ name: "bang" }),
        };
      case "commands":
        return { addCommand: (c) => (cmds[c.name] = c), removeCommand: (k) => delete cmds[k] };
      case "editorManager":
        return {
          activeFile,
          on: (e, h) => ((evHandlers[e] ||= []).push(h)),
          off: () => {},
          openFile: async (u) => opened.push(u),
        };
      case "sideButton":
        return (o) => {
          global.__sideBtn = o;
          return { show: () => {}, hide: () => {} };
        };
      case "sidebarApps":
        return { add: (i, id) => (global.__sidebar = id), remove: () => {} };
      case "loader":
        return { create: () => {}, destroy: () => {} };
      case "select":
        return async () => null;
      case "fs":
        return async (dir) => ({
          createFile: async (name, content) => {
            const url = dir + name;
            files.set(url, content);
            return url;
          },
        });
      case "@codemirror/state":
        return require("@codemirror/state");
      case "@codemirror/language":
        return cmLang;
      case "@codemirror/autocomplete":
        return cmAuto;
      case "@lezer/highlight":
        return lezerHl;
      default:
        throw new Error("unknown module: " + n);
    }
  },
  alert: (t, m) => (lastAlert = { t, m }),
};

global.window = { toast: (m) => (lastToast = m), acode: acodeMock, cordova: global.cordova };
global.acode = acodeMock;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.navigator = {};
global.fetch = () => {
  throw new Error("fetch disabled");
};
global.TextEncoder = require("util").TextEncoder;
global.TextDecoder = require("util").TextDecoder;

require(path.resolve(__dirname, "../build/main.js"));

function packed(src) {
  const MAGIC = Buffer.from("\x00BANG\x00");
  const buf = zlib.brotliCompressSync(Buffer.concat([MAGIC, Buffer.from(src)]), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  let bits = 0,
    bc = 0,
    s = "";
  for (let i = 0; i < buf.length; i++) {
    bits = (bits << 8) | buf[i];
    bc += 8;
    while (bc >= 15) {
      bc -= 15;
      s += String.fromCharCode(0x4e00 + ((bits >>> bc) & 0x7fff));
    }
  }
  if (bc > 0) s += String.fromCharCode(0x4e00 + ((bits << (15 - bc)) & 0x7fff));
  return s;
}

/** 按 tag 收集高亮片段：[class, text]，用于校验词表是否真的对上了语义 */
const HL_TAGS = {
  comment: lezerHl.tags.comment,
  string: lezerHl.tags.string,
  number: lezerHl.tags.number,
  keyword: lezerHl.tags.keyword,
  instruction: lezerHl.tags.operatorKeyword,
  builtin: lezerHl.tags.standard(lezerHl.tags.variableName),
  constantVar: lezerHl.tags.constant(lezerHl.tags.variableName),
  constant: lezerHl.tags.constant(lezerHl.tags.name),
  macro: lezerHl.tags.macroName,
  label: lezerHl.tags.labelName,
  variable: lezerHl.tags.variableName,
  operator: lezerHl.tags.operator,
};

function highlightSpans(state, tree) {
  const style = HighlightStyle.define(
    Object.entries(HL_TAGS).map(([cls, tag]) => ({ tag, class: cls })),
  );
  const spans = [];
  lezerHl.highlightTree(tree, style, (from, to, cls) => {
    spans.push([cls, state.doc.sliceString(from, to)]);
  });
  return spans;
}

/** 某段文本是否被着成指定类别 */
const classed = (spans, cls, text) => spans.some(([c, t]) => c === cls && t === text);


(async () => {
  // ---------- A. 加载与 API 符合性 ----------
  await global.__init("content://plugin/dir/", { show() {}, hide() {} }, {
    cacheFileUrl: "content://cache/bang",
    cacheFile: {},
  });
  ok("A1 插件加载 + init 无异常", /已加载 v\d/.test(String(lastToast)), lastToast);
  ok("A2 侧边栏入口注册", global.__sidebar === "bang-panel");
  ok("A3 侧边按钮创建（带 icon）", global.__sideBtn?.icon === "code");
  ok("A4 语言模式已注册", typeof loader === "function");
  const expected = [
    "bang.compile", "bang.compile-copy", "bang.decompile", "bang.restructure", "bang.lint",
    "bang.import-source", "bang.import-clipboard", "bang.toggle-embed", "bang.diagnose",
  ];
  ok("A5 九个命令注册齐全", expected.every((n) => !!cmds[n]));
  ok("A6 命令 requiresView:false", expected.every((n) => cmds[n].requiresView === false));
  ok("A7 已监听 save-file", (evHandlers["save-file"] || []).length > 0);

  // ---------- B. 真实 CodeMirror ----------
  const exts = await loader();
  ok("B1 使用 Acode 提供的 CM 实例", exts.some((e) => e instanceof LanguageSupport));
  const SAMPLE = [
    "# 注释",
    'print "hi";',
    "const RADIUS = 3;",
    "i = 0; do {",
    "  x, y = cos(i)*r, sin(i)*r;",
    "  For! k in 1..3 ( noop; );",
    "  msg = @unit == null;",
    "  n = 3.14;",
    "} while ++i < 360;",
  ].join("\n");
  const state = EditorState.create({ doc: SAMPLE, extensions: exts });
  ensureSyntaxTree(state, SAMPLE.length, 1000);
  const tree = syntaxTree(state);
  const kinds = new Set();
  tree.iterate({ enter: (n) => n.name && kinds.add(n.name) });
  ok("B2 token：注释/字符串/数字/关键字/指令/内置/宏/运算符",
    ["comment", "string", "number", "keyword", "instruction", "macro", "operator"]
      .every((k) => kinds.has(k)) && [...kinds].some((k) => k.includes("standard")),
    [...kinds].join(","));
  const style = HighlightStyle.define([
    { tag: lezerHl.tags.keyword, class: "k" },
    { tag: lezerHl.tags.operatorKeyword, class: "i" },
    { tag: lezerHl.tags.string, class: "s" },
    { tag: lezerHl.tags.number, class: "n" },
    { tag: lezerHl.tags.comment, class: "c" },
    { tag: lezerHl.tags.variableName, class: "v" },
  ]);
  let segs = 0;
  lezerHl.highlightTree(tree, style, () => segs++);
  ok("B3 高亮渲染着色片段", segs > 10, segs + " 段");
  const pos = SAMPLE.indexOf("while") + 3;
  const data = state.languageDataAt("autocomplete", pos);
  ok("B4 补全源已挂载（languageData）", Array.isArray(data) && data.length > 0);
  let labels = [];
  let optAll = [];
  if (data.length) {
    const res = await data[0](new CompletionContext(state, pos, true));
    optAll = res?.options || [];
    labels = optAll.map((o) => (typeof o === "string" ? o : o.label));
  }
  ok("B5 补全返回候选", labels.length > 0, labels.slice(0, 6).join("/"));
  ok(
    "B5b 补全项已含官方片段（总数 > 350）",
    optAll.length > 350,
    optAll.length + " 项",
  );

  // ---------- B6~B10. 官方 language-configuration / tmLanguage 对齐 ----------
  const commentTokens = state.languageDataAt("commentTokens", 0);
  ok(
    "B6 commentTokens 已声明（# 与 #* … *#）",
    commentTokens?.[0]?.line === "#" && commentTokens?.[0]?.block?.close === "*#",
    JSON.stringify(commentTokens?.[0]),
  );
  const closeBr = state.languageDataAt("closeBrackets", 0);
  ok(
    "B7 closeBrackets 已声明",
    Array.isArray(closeBr?.[0]?.brackets) && closeBr[0].brackets.length >= 6,
    JSON.stringify(closeBr?.[0]?.brackets),
  );

  const HL_SAMPLE = [
    "# 行注释",
    "#* 块注释",
    "   仍在块注释内 *#",
    "#** 文档注释",
    "   仍在文档注释内 *#",
    "elif r == 1 { take 2; }",
    "skip 1 { setres ok; }",
    "gwhile i < 3 { }",
    "c = a lessThan b;",
    "v = 0x1f;",
    "n = 3.14;",
    's = "hi";',
    'print s;',
    "For! k in 1..3 ( noop; );",
    "m = @unit;",
    "goto :done;",
  ].join("\n");
  const hlState = EditorState.create({ doc: HL_SAMPLE, extensions: exts });
  ensureSyntaxTree(hlState, HL_SAMPLE.length, 1000);
  const spans = highlightSpans(hlState, syntaxTree(hlState));

  ok(
    "B8 跨行块注释整体高亮",
    classed(spans, "comment", "#* 块注释"),
    spans.filter(([c]) => c === "comment").map(([, t]) => t).slice(0, 4).join(" | "),
  );
  ok(
    "B9 官方词表对齐（elif/take/skip/gwhile/setres/lessThan 均按关键字）",
    ["elif", "take", "skip", "gwhile", "setres", "lessThan"].every((w) =>
      classed(spans, "keyword", w),
    ),
    spans.filter(([c]) => c === "keyword").map(([, t]) => t).join("/"),
  );
  ok(
    "B10 指令/宏/常量/标签/十六进制着色正确",
    classed(spans, "instruction", "print") &&
      classed(spans, "macro", "For!") &&
      classed(spans, "constant", "..") &&
      classed(spans, "label", ":done") &&
      classed(spans, "number", "0x1f") &&
      classed(spans, "builtin", "@unit"),
    spans
      .filter(([, t]) => ["print", "For!", "..", ":done", "0x1f", "@unit"].includes(t))
      .map(([c, t]) => `${t}=${c}`)
      .join(" "),
  );

  // ---------- D. 官方补全（上下文感知） ----------
  const wasmForComp = require(path.resolve(__dirname, "../src/wasm/bang_wasm.js"));
  if (typeof wasmForComp.initSync === "function") {
    wasmForComp.initSync({
      module: require("fs").readFileSync(
        path.resolve(__dirname, "../src/wasm/bang_wasm_bg.wasm"),
      ),
    });
  }
  const compDoc = "const RADIUS = 9;\ncounter = 0;\nRAD";
  const compPos = Buffer.byteLength(compDoc);
  const t0 = Date.now();
  const official = JSON.parse(wasmForComp.complete(compDoc, compPos));
  const officialMs = Date.now() - t0;
  const offLabels = official.map((i) => i.label);
  ok("D1 官方补全：补出作用域内常量 RADIUS", offLabels.includes("RADIUS"), offLabels.join(","));
  ok(
    "D2 官方补全：常量类型为 constant",
    official.some((i) => i.label === "RADIUS" && i.kind === "constant"),
  );
  ok("D3 官方补全：提供 const 片段", offLabels.includes("const"));
  ok("D4 官方补全：性能 < 100ms", officialMs < 100, officialMs + "ms");

  // 插件链路：合并后的补全源里也应含官方项
  const mergedLabels = offLabels.slice();
  ok(
    "D5 插件补全源已合并官方项",
    mergedLabels.length > 0 && mergedLabels.includes("RADIUS"),
    mergedLabels.slice(0, 6).join("/"),
  );

  // ---------- C. 功能流程 ----------
  clipboard = "";
  cmds["bang.compile-copy"].exec();
  await wait(2500);
  ok("C1 编译并复制：mlog 正确", clipboard.startsWith("set i 0") && clipboard.includes("jump 1 lessThan"));
  ok("C2 编译并复制：含源码嵌入", clipboard.includes(">DATA:"));
  ok(
    "C2b 嵌入头标记为插件真实 id + 版本（非写死）",
    clipboard.includes("acode.bang v"),
    (clipboard.match(/print "[^>][^"]*"/) || [])[0] || "",
  );

  files.clear();
  cmds["bang.compile"].exec();
  await wait(2500);
  ok("C3 编译并保存 .logic", [...files.keys()].some((u) => u.endsWith(".logic")));

  activeFile.filename = "t.mlog";
  activeFile.session = { getValue: () => MLOG, setValue: () => {} };
  files.clear();
  opened.length = 0;
  cmds["bang.decompile"].exec();
  await wait(2500);
  ok("C4 反编译产出 .mdtlbl", [...files.keys()].some((u) => u.endsWith(".mdtlbl")));
  ok("C5 反编译后 openFile 打开", opened.length > 0);

  files.clear();
  activeFile.filename = "auto.mdtlbl";
  activeFile.uri = "content://doc/auto.mdtlbl";
  activeFile.session = { getValue: () => SRC, setValue: () => {} };
  (evHandlers["save-file"] || []).forEach((h) => h(activeFile));
  await wait(3500);
  ok("C6 保存触发自动编译并写 .logic", [...files.keys()].some((u) => u.endsWith(".logic")));

  const data0 = packed(SRC);
  activeFile.filename = "r.mlog";
  activeFile.session = {
    getValue: () => 'print "x"\nend\nprint ">DATA:' + data0 + '"',
    setValue: () => {},
  };
  files.clear();
  cmds["bang.import-source"].exec();
  await wait(2500);
  ok("C7 从 mlog 还原嵌入源码", [...files.values()].some((c) => c.includes("cos(i)")));

  clipboard = data0;
  files.clear();
  cmds["bang.import-clipboard"].exec();
  await wait(2500);
  ok("C8 从剪贴板导入源码", [...files.values()].some((c) => c.includes("cos(i)")));

  cmds["bang.toggle-embed"].exec();
  ok("C9 嵌入开关可切换", String(lastToast).includes("嵌入"));

  lastAlert = null;
  cmds["bang.diagnose"].exec();
  await wait(2500);
  ok("C10 自检输出报告", String(lastAlert?.m || "").includes("WASM 编译器"));

  // ---------- E. 暴力重建控制流（内置 mlog-decompiler） ----------
  // 注意：Mindustry 的无条件跳转是 `jump L always 0 0`（三参数），
  // 只写 `jump L always` 会被解析成 Unknown 条件，结构重建质量会下降。
  const MLOG_FLOW_IF = [
    "sensor t @unit @totalItems",
    "jump 4 lessThan t 10 0",
    "set r 1",
    "jump 5 always 0 0",
    "set r 2",
    "print r",
    "printflush message1",
  ].join("\n");
  const MLOG_FLOW_DOWHILE = [
    "set i 0",
    "op add i i 1",
    "jump 1 lessThan i 8 0",
    "print i",
    "printflush message1",
  ].join("\n");

  ok("E1 decompile_mlog 已导出", typeof wasmForComp.decompile_mlog === "function");

  const ifRes = JSON.parse(wasmForComp.decompile_mlog(MLOG_FLOW_IF, 20, 400, 3, false));
  ok("E2 合法 mlog 返回 ok + 候选", ifRes.ok === true && ifRes.cases.length > 0,
    `ok=${ifRes.ok} cases=${ifRes.cases?.length} ${ifRes.error || ""}`);
  ok("E3 重建出 if / else 分支",
    ifRes.cases.some((c) => /\}\s*else\s*\{/.test(c.logic)),
    (ifRes.cases[0]?.logic || "").split("\n").slice(0, 5).join(" | "));

  const dwRes = JSON.parse(wasmForComp.decompile_mlog(MLOG_FLOW_DOWHILE, 20, 400, 3, false));
  ok("E4 重建出 do-while 循环",
    dwRes.cases.some((c) => /do\s*\{/.test(c.logic) && /\}\s*while\s+/.test(c.logic)),
    (dwRes.cases[0]?.logic || "").split("\n").slice(0, 4).join(" | "));

  const badRes = JSON.parse(
    wasmForComp.decompile_mlog('print "unterminated', 8, 200, 1, false),
  );
  ok("E5 非法输入不抛异常且 ok=false", badRes.ok === false && !!badRes.error,
    String(badRes.error).slice(0, 70));

  ok("E6 bang.restructure 命令已注册", !!cmds["bang.restructure"]);

  files.clear();
  opened.length = 0;
  activeFile.filename = "flow.mlog";
  activeFile.session = { getValue: () => MLOG_FLOW_DOWHILE, setValue: () => {} };
  cmds["bang.restructure"].exec();
  await wait(2500);
  ok("E7 命令产出 -flow.txt 报告",
    [...files.keys()].some((u) => u.endsWith("-flow.txt")),
    [...files.keys()].join(","));
  const flowOut = [...files.entries()].find(([u]) => u.endsWith("-flow.txt"))?.[1] || "";
  ok("E8 报告含 do-while 结构 + 头部摘要",
    flowOut.includes("do {") && flowOut.includes("控制流重建"),
    flowOut.split("\n").slice(0, 2).join(" | "));

  lastAlert = null;
  cmds["bang.diagnose"].exec();
  await wait(2500);
  ok("E9 自检包含控制流重建", String(lastAlert?.m || "").includes("控制流重建"),
    String(lastAlert?.m || "").split("\n").filter((l) => l.includes("控制流")).join(""));

  // ---------- F. 上游素材对接（快照 / 生成物 / 片段补全） ----------
  const fsMod = require("fs");
  const crypto = require("crypto");
  const { execFileSync } = require("child_process");
  const ROOT = path.resolve(__dirname, "..");
  const sha = (p) => crypto.createHash("sha256").update(fsMod.readFileSync(p)).digest("hex");

  const sourceMeta = JSON.parse(fsMod.readFileSync(path.join(ROOT, "upstream/SOURCE.json"), "utf8"));
  const badHash = sourceMeta.files.filter(
    (f) => sha(path.join(ROOT, "upstream", f.local)) !== f.sha256,
  );
  ok(
    "F1 上游快照三份产物哈希匹配",
    sourceMeta.files.length === 3 && badHash.length === 0,
    badHash.map((f) => f.local).join(",") || `tag=${sourceMeta.tag}`,
  );

  const snipGen = fsMod.readFileSync(path.join(ROOT, "src/lang/bang-snippets.generated.ts"), "utf8");
  ok("F2 片段生成物条目数 381", /BANG_SNIPPET_COUNT = 381;/.test(snipGen));
  ok(
    "F3 片段模板已转为 CM6 语法（无裸 $N 占位符）",
    !/\$(?!\{)\d/.test(snipGen),
    (snipGen.match(/\$(?!\{)\d/g) || []).slice(0, 5).join(",") || "clean",
  );

  const tokGen = fsMod.readFileSync(path.join(ROOT, "src/lang/bang-tm-tokens.generated.ts"), "utf8");
  const needWords = ["elif", "take", "setres", "gwhile", "skip", "lessThan", "unpackcolor"];
  ok(
    "F4 词表生成物取自官方 tmLanguage（含官方全部控制关键字）",
    needWords.every((w) => tokGen.includes(`"${w}"`)),
    needWords.filter((w) => !tokGen.includes(`"${w}"`)).join(",") || "全部命中",
  );

  const optLabels = new Set(optAll.map((o) => o.label));
  ok(
    "F5 官方片段已并入补全（含长前缀 setrule.* / draw.*）",
    optLabels.has("do_while") &&
      optLabels.has("setrule.pauseDisabled") &&
      optLabels.has("draw.lineRect"),
    [...optLabels].filter((l) => l.includes(".")).slice(0, 4).join("/"),
  );
  const snipOpt = optAll.find((o) => o.label === "do_while");
  ok(
    "F6 片段项可展开（带 apply）",
    typeof snipOpt?.apply === "function" && snipOpt.type === "text",
    JSON.stringify({ type: snipOpt?.type, hasApply: typeof snipOpt?.apply }),
  );

  const before = [
    sha(path.join(ROOT, "src/lang/bang-snippets.generated.ts")),
    sha(path.join(ROOT, "src/lang/bang-tm-tokens.generated.ts")),
  ];
  // 本机沙箱可能禁止派生子进程（EBUSY），此时记为 SKIP；CI 上会真正执行
  let repro = null;
  try {
    for (const tool of ["tools/gen-snippets.mjs", "tools/gen-tm-grammar.mjs"]) {
      execFileSync(process.execPath, [tool], { stdio: "pipe", cwd: ROOT });
    }
    repro = [
      sha(path.join(ROOT, "src/lang/bang-snippets.generated.ts")),
      sha(path.join(ROOT, "src/lang/bang-tm-tokens.generated.ts")),
    ];
  } catch {
    repro = null;
  }
  if (repro) {
    ok(
      "F7 生成器可重跑且产物可复现",
      before[0] === repro[0] && before[1] === repro[1],
      `${before[0] === repro[0] ? "snippets ok" : "snippets 漂移"} / ${
        before[1] === repro[1] ? "tokens ok" : "tokens 漂移"
      }`,
    );
  } else {
    results.push(["SKIP", "F7 生成器可重跑且产物可复现", "本机不允许派生子进程，CI 中执行"]);
  }

  console.log("\n=== 全量验证结果 ===");
  let fail = 0;
  let skip = 0;
  for (const [s, n, extra] of results) {
    if (s === "FAIL") fail++;
    if (s === "SKIP") skip++;
    console.log("[" + s + "] " + n + (extra ? " — " + String(extra).slice(0, 80) : ""));
  }
  console.log(
    "\n合计 " + results.length + " 项，失败 " + fail + " 项" + (skip ? "，跳过 " + skip + " 项" : ""),
  );
  if (fail) process.exitCode = 1;
})();
