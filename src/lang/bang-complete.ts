import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { ensureReady } from "../bang-core/compiler-wasm";
import { complete as wasmComplete } from "../wasm/bang_wasm.js";

/**
 * Bang 补全源
 * 1) 官方实现：调用内置 wasm 里的官方补全算法（上游 tools/bangls 移植）
 *    —— 上下文感知，补全当前作用域真实可见的变量 / 常量 / 绑定
 * 2) 静态补充：mlog 指令、关键字、@内置变量、常用片段
 */

interface Item {
  label: string;
  type: string;
  detail: string;
  apply?: string;
}

const INSTRUCTIONS = [
  "set", "op", "iop", "jump", "sensor", "control", "radar", "read", "write",
  "draw", "print", "printchar", "format", "drawflush", "printflush", "getlink",
  "wait", "stop", "end", "ubind", "ucontrol", "uradar", "ulocate", "lookup",
  "packcolor", "sync", "fetch", "getflag", "setflag", "setprop", "setrate",
  "spawn", "spawnwave", "applystatus", "weathersense", "weatherset", "setrule",
  "flushmessage", "cutscene", "effect", "explosion", "playsound", "setmarker",
  "makemarker", "getblock", "setblock", "noop",
];

const KEYWORDS = [
  "do", "while", "if", "else", "break", "continue", "case", "match",
  "const", "let", "var", "fn", "return", "in", "for", "select", "sync",
];

const BUILTINS = [
  "@unit", "@this", "@thisx", "@thisy", "@ipt", "@time", "@links",
  "@counter", "@pi", "@e",
];

const SNIPPETS: Array<{ label: string; detail: string; apply: string }> = [
  { label: "do-while", detail: "do { … } while 条件;", apply: "do {\n\t\n} while ;" },
  { label: "if", detail: "if 条件 { … }", apply: "if () {\n\t\n}" },
  { label: "For!", detail: "标准库循环 For! i in 1..6 ( … );", apply: "For! i in 1..6 (\n\t\n);" },
  { label: "CountLoop!", detail: "循环展开 CountLoop! i 5 const( … );", apply: "CountLoop! i 5 const(\n\t\n);" },
  { label: "print", detail: "输出并刷新", apply: 'print "";\nprintflush message1;' },
  { label: "const", detail: "编译期常量", apply: "const X = 1;" },
];

const STATIC_ITEMS: Item[] = [
  ...KEYWORDS.map((k) => ({ label: k, type: "keyword", detail: "关键字" })),
  ...INSTRUCTIONS.map((i) => ({ label: i, type: "function", detail: "mlog 指令" })),
  ...BUILTINS.map((b) => ({ label: b, type: "variable", detail: "内置变量" })),
  ...SNIPPETS.map((s) => ({ label: s.label, type: "text", detail: s.detail, apply: s.apply })),
];

/** CM 补全类型映射（对应 wasm 返回的 kind） */
const KIND_MAP: Record<string, string> = {
  constant: "constant",
  variable: "variable",
  method: "method",
  field: "property",
  keyword: "keyword",
  text: "text",
};

/** 官方片段里的 LSP 占位符 → 普通文本 */
function normalizeSnippet(text: string): string {
  return text
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "")
    .replace(/\$\d/g, "");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 调用官方补全（失败返回空数组，不影响静态补全） */
export function officialCompletions(doc: string, pos: number): Item[] {
  try {
    ensureReady();
    const json = wasmComplete(doc, utf8Length(doc.slice(0, pos)));
    const raw = JSON.parse(json) as Array<{
      label: string;
      detail: string;
      insert_text: string;
      kind: string;
      snippet: boolean;
    }>;
    return raw.map((it) => ({
      label: it.label,
      type: KIND_MAP[it.kind] || "text",
      detail: it.detail.replace(/\n/g, " · ").slice(0, 90),
      apply: it.snippet || it.insert_text !== it.label
        ? normalizeSnippet(it.insert_text)
        : undefined,
    }));
  } catch (e) {
    console.warn("[bang] 官方补全不可用", e);
    return [];
  }
}

/** CodeMirror 补全源（静态 + 官方） */
export function bangCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const atWord = context.matchBefore(/@[\w.-]*/);
  if (atWord) {
    return { from: atWord.from, options: BUILTINS.map((b) => ({ label: b, type: "variable" })), validFor: /^@[\w.-]*$/ };
  }
  const word = context.matchBefore(/[A-Za-z_][\w.!-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const doc = context.state.doc.toString();
  const official = officialCompletions(doc, context.pos);
  const seen = new Set(official.map((i) => i.label));
  const merged = [
    ...official,
    ...STATIC_ITEMS.filter((i) => !seen.has(i.label)),
  ];
  return { from: word.from, options: merged as never, validFor: /^[\w.!-]*$/ };
}
