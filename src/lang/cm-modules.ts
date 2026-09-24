import * as bundledLanguage from "@codemirror/language";
import * as bundledAutocomplete from "@codemirror/autocomplete";
import * as bundledHighlight from "@lezer/highlight";

/**
 * 共享 CodeMirror 模块解析
 *
 * 关键点：CM6 内部用 `instanceof` / facet 身份校验扩展。若插件自带一份
 * `@codemirror/state`，与 Acode 编辑器那份不是同一实例，注入时会抛
 * "Unrecognized extension value ... multiple instances"。
 *
 * 因此凡是「要被编辑器消费」的扩展都必须用 Acode 的实例构造：
 *   - StreamLanguage / LanguageSupport（语言解析器）
 *   - snippetCompletion 的 apply 函数（会 appendConfig 一个 StateField）
 *   - autocompletion（由 Acode 全局启用，插件只通过 languageData 提供源）
 *
 * 拿不到 Acode 实例时回退到插件自带副本（仅用于类型与纯数据场景）。
 */

export interface CMModules {
  /** @codemirror/language */
  language: any;
  /** @codemirror/autocomplete */
  autocomplete: any;
  /** @lezer/highlight */
  highlight: any;
  /** 三个模块是否都来自 Acode 内置实例（决定能否安全注入扩展） */
  fromAcode: boolean;
}

let modules: CMModules | null = null;

export function getCMModules(): CMModules {
  if (modules) return modules;
  try {
    const language = acode.require("@codemirror/language") as any;
    const autocomplete = acode.require("@codemirror/autocomplete") as any;
    const highlight = acode.require("@lezer/highlight") as any;
    if (
      language?.StreamLanguage &&
      language?.LanguageSupport &&
      autocomplete?.autocompletion
    ) {
      modules = { language, autocomplete, highlight: highlight ?? bundledHighlight, fromAcode: true };
      return modules;
    }
  } catch (e) {
    console.warn("[bang] 使用 Acode 内置 CodeMirror 失败，回退到插件自带副本", e);
  }
  modules = {
    language: bundledLanguage,
    autocomplete: bundledAutocomplete,
    highlight: bundledHighlight,
    fromAcode: false,
  };
  return modules;
}

/**
 * 构造带占位符的补全项。
 *
 * 用 Acode 的 snippetCompletion 时，apply 会往编辑器里 appendConfig 一个
 * StateField —— 只有实例一致才安全；回退副本时改为纯文本插入 + 光标落位，
 * 牺牲 Tab 跳转换来不炸编辑器。
 */
export function snippetItem(
  template: string,
  base: { label: string; detail?: string; type?: string; boost?: number },
): any {
  const mods = getCMModules();
  if (mods.fromAcode && typeof mods.autocomplete?.snippetCompletion === "function") {
    return mods.autocomplete.snippetCompletion(template, base);
  }
  return { ...base, apply: plainApply(template) };
}

/** 取一个缩进单位，拿不到编辑器 facet 时退回两个空格 */
function indentOf(state: any): string {
  try {
    const s = getCMModules().language?.indentString?.(state, 1);
    if (typeof s === "string") return s;
  } catch {
    /* 实例不一致时忽略，走默认值 */
  }
  return "  ";
}

/**
 * 纯文本 apply：按当前行缩进展开模板，去掉占位标记，光标落到第一个占位处。
 * 只在拿不到 Acode 的 snippetCompletion 时使用（无法做 Tab 跳转）。
 */
function plainApply(template: string) {
  return (view: any, _completion: any, from: number, to: number) => {
    const line = view.state.doc.lineAt(from);
    const baseIndent = /^[\t ]*/.exec(line.text)?.[0] ?? "";
    const unit = indentOf(view.state);

    // 1) 按缩进规则重排各行：非首行按前导 Tab 数换成「基准缩进 + N 个缩进单位」
    const lines = template
      .split("\n")
      .map((raw, i) =>
        i === 0
          ? raw
          : baseIndent + unit.repeat(/^\t*/.exec(raw)![0].length) + raw.replace(/^\t*/, ""),
      );

    // 2) 把占位标记换成默认值，同时记录第一个占位符的字符偏移（光标落点）
    let out = "";
    let cursor = -1;
    const re = /\$\{(\d+)(?::([^{}]*))?\}/g;
    for (const lineText of lines) {
      if (out) out += "\n";
      let last = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(lineText))) {
        out += lineText.slice(last, m.index);
        if (cursor < 0) cursor = out.length;
        out += m[2] ?? "";
        last = m.index + m[0].length;
      }
      out += lineText.slice(last);
    }

    view.dispatch({
      changes: { from, to, insert: out },
      selection: { anchor: from + (cursor < 0 ? out.length : cursor) },
      scrollIntoView: true,
      userEvent: "input.complete",
    });
  };
}
