import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { ensureReady } from "../bang-core/compiler-wasm";
import { complete as wasmComplete } from "../wasm/bang_wasm.js";
import { snippetItem } from "./cm-modules";
import { BANG_SNIPPETS, BANG_SNIPPET_COUNT } from "./bang-snippets.generated";
import {
  CONTROL_KEYWORDS,
  MODIFIER_KEYWORDS,
  INSTRUCTIONS,
  CONSTANTS,
} from "./bang-tm-tokens.generated";

/**
 * Bang 补全源，三层叠加：
 *   1) 官方算法：内置 wasm 里的上下文感知补全（上游 tools/bangls 移植）
 *      —— 只列当前作用域真实可见的变量 / 常量 / 绑定
 *   2) 官方片段：upstream/snippets.json 的 381 条（tools/gen-snippets.mjs 生成）
 *      —— 支持 ${1} / ${1:默认} 占位符，可 Tab 跳转
 *   3) 静态兜底：mlog 指令、关键字、@内置变量、少量本仓库自备片段
 *
 * 词表全部取自官方 tmLanguage（tools/gen-tm-grammar.mjs），不再手抄。
 * 同名去重顺序：官方算法 > 官方片段 > 静态项（片段比裸关键字更有用）。
 */

export { BANG_SNIPPET_COUNT };

interface Item {
  label: string;
  type: string;
  detail: string;
  apply?: string;
}

const BUILTINS = [
  "@unit", "@this", "@thisx", "@thisy", "@ipt", "@time", "@links",
  "@counter", "@pi", "@e",
];

/** 官方片段里没有、但本仓库要保留的自备片段 */
const LOCAL_SNIPPETS: Array<[label: string, detail: string, template: string]> = [
  ["For!", "标准库循环 For! i in 1..6 ( … );", "For! ${1:i} in ${2:1}..${3:6} (\n\t${0}\n);"],
  ["CountLoop!", "循环展开 CountLoop! i 5 const( … );", "CountLoop! ${1:i} ${2:5} const(\n\t${0}\n);"],
  ["print", "输出并刷新", 'print "${1}";\nprintflush message1;'],
];

const STATIC_ITEMS: Item[] = [
  ...CONTROL_KEYWORDS.map((k) => ({ label: k, type: "keyword", detail: "关键字" })),
  ...MODIFIER_KEYWORDS.map((k) => ({ label: k, type: "keyword", detail: "修饰关键字" })),
  ...INSTRUCTIONS.map((i) => ({ label: i, type: "function", detail: "mlog 指令" })),
  ...CONSTANTS.map((c) => ({ label: c, type: "constant", detail: "语言常量" })),
  ...BUILTINS.map((b) => ({ label: b, type: "variable", detail: "内置变量" })),
];

/** 官方片段 + 自备片段，预构建为 CM 补全项（与上下文无关，只建一次） */
const SNIPPET_ITEMS: any[] = [...BANG_SNIPPETS, ...LOCAL_SNIPPETS].map(
  ([label, detail, template]) =>
    snippetItem(template, { label, detail, type: "text", boost: 1 }),
);

/** CM 补全类型映射（对应 wasm 返回的 kind） */
const KIND_MAP: Record<string, string> = {
  constant: "constant",
  variable: "variable",
  method: "method",
  field: "property",
  keyword: "keyword",
  text: "text",
};

/** VSCode / LSP 片段占位符 → CM6：裸 $N 补成 ${N}；花括号形式语法一致 */
function toCmTemplate(text: string): string {
  return text.replace(/\\\$/g, "$").replace(/\$(?!\{)(\d+)/g, "${$1}");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 调用官方补全（失败返回空数组，不影响其余两层） */
export function officialCompletions(doc: string, pos: number): any[] {
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
    return raw.map((it) => {
      const detail = it.detail.replace(/\n/g, " · ").slice(0, 90);
      const base = { label: it.label, detail, type: KIND_MAP[it.kind] || "text" };
      // 官方插入文本是片段形式（如 `Var! $0;`）时走占位符通道
      return it.snippet || it.insert_text !== it.label
        ? snippetItem(toCmTemplate(it.insert_text), base)
        : base;
    });
  } catch (e) {
    console.warn("[bang] 官方补全不可用", e);
    return [];
  }
}

/** CodeMirror 补全源（官方算法 + 官方片段 + 静态兜底） */
export function bangCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const atWord = context.matchBefore(/@[\w.-]*/);
  if (atWord) {
    return {
      from: atWord.from,
      options: BUILTINS.map((b) => ({ label: b, type: "variable" })),
      validFor: /^@[\w.-]*$/,
    };
  }
  const word = context.matchBefore(/[A-Za-z_][\w.!-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const doc = context.state.doc.toString();
  const options: any[] = [];
  const seen = new Set<string>();
  const push = (list: any[]) => {
    for (const it of list) {
      if (seen.has(it.label)) continue;
      seen.add(it.label);
      options.push(it);
    }
  };

  push(officialCompletions(doc, context.pos));
  push(SNIPPET_ITEMS);
  push(STATIC_ITEMS);

  return { from: word.from, options, validFor: /^[\w.!-]*$/ };
}
