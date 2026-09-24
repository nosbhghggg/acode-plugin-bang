import * as bundledLanguage from "@codemirror/language";
import * as bundledAutocomplete from "@codemirror/autocomplete";
import * as bundledHighlight from "@lezer/highlight";
import { bangCompletionSource } from "./bang-complete";

/**
 * Bang (mindustry_logic_bang_lang) 语法定义
 *
 * 关键点 1：语言扩展必须用 LanguageSupport 包装（Acode 的 getLanguageParser
 *   通过 `"language" in ext` 取解析器，裸 StreamLanguage 会被判为无解析器）。
 * 关键点 2：必须优先使用 Acode 自带的 CodeMirror 模块实例。
 *   CM6 内部用 instanceof 校验扩展，若插件自带一份 @codemirror/state，
 *   会抛出 "Unrecognized extension value ... multiple instances" 导致高亮失效。
 */

interface CMModules {
  language: any;
  autocomplete: any;
  highlight: any;
}

let modules: CMModules | null = null;

function getCMModules(): CMModules {
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
      modules = { language, autocomplete, highlight: highlight ?? bundledHighlight };
      return modules;
    }
  } catch (e) {
    console.warn("[bang] 使用 Acode 内置 CodeMirror 失败，回退到插件自带副本", e);
  }
  modules = {
    language: bundledLanguage,
    autocomplete: bundledAutocomplete,
    highlight: bundledHighlight,
  };
  return modules;
}

function buildTokenTable(tags: any) {
  return {
    comment: tags.comment,
    string: tags.string,
    number: tags.number,
    keyword: tags.keyword,
    instruction: tags.operatorKeyword,
    builtin: tags.standard(tags.variableName),
    link: tags.special(tags.variableName),
    macro: tags.macroName,
    label: tags.labelName,
    variable: tags.variableName,
    operator: tags.operator,
  };
}

const INSTRUCTIONS = new Set([
  "set", "op", "iop", "jump", "sensor", "control", "radar", "read", "write",
  "draw", "print", "printchar", "format", "drawflush", "printflush", "getlink",
  "wait", "stop", "end", "ubind", "ucontrol", "uradar", "ulocate", "lookup",
  "packcolor", "sync", "fetch", "getflag", "setflag", "setprop", "setrate",
  "spawn", "spawnwave", "applystatus", "weathersense", "weatherset", "setrule",
  "flushmessage", "cutscene", "effect", "explosion", "playsound", "setmarker",
  "makemarker", "getblock", "setblock", "noop",
]);

const KEYWORDS = new Set([
  "do", "while", "if", "else", "break", "continue", "case", "match",
  "const", "let", "var", "fn", "return", "in", "for", "select", "sync",
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$\\]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_\\.-]/.test(ch);
}

function token(stream: any): string | null {
  if (stream.eatSpace()) return null;

  if (stream.match("#")) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.match(/^"(?:[^"\\]|\\.)*?"/)) return "string";
  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
  if (stream.match(/^@[\w.-]+/)) return "builtin";
  if (stream.match(/^\$[\w.-]+/)) return "link";
  if (stream.sol() && stream.match(/^[A-Za-z_][\w.-]*:/)) return "label";

  if (isIdentStart(stream.peek())) {
    const start = stream.pos;
    while (!stream.eol() && isIdentChar(stream.peek())) stream.next();
    const word = stream.string.slice(start, stream.pos);
    if (stream.peek() === "!") {
      stream.next();
      return "macro";
    }
    if (INSTRUCTIONS.has(word.toLowerCase())) return "instruction";
    if (KEYWORDS.has(word.toLowerCase())) return "keyword";
    return "variable";
  }

  if (stream.match(/^[=+\-*/%<>!&|,:;()\[\]{}]/)) return "operator";

  stream.next();
  return null;
}

export const BANG_EXTENSIONS = ["mdtlbl", "mdtl"];
export const BANG_MODE_NAME = "bang";
export const BANG_MODE_CAPTION = "Mindustry Bang";

let cachedExtensions: any[] | null = null;

/** 构建语言扩展，使用 Acode 的 CodeMirror 实例。
 *  补全通过 languageData 提供（Acode 已全局启用 autocompletion，
 *  这是官方认可的插件补全方式；插件无需再插一个 autocompletion 扩展）。 */
export function bangExtensions(): any[] {
  if (cachedExtensions) return cachedExtensions;
  const mods = getCMModules();
  const bangLanguage = mods.language.StreamLanguage.define({
    token,
    tokenTable: buildTokenTable(mods.highlight.tags),
    name: "bang",
  });
  const support = new mods.language.LanguageSupport(bangLanguage, [
    bangLanguage.data.of({ autocomplete: bangCompletionSource as any }),
  ]);
  cachedExtensions = [support];
  return cachedExtensions;
}
