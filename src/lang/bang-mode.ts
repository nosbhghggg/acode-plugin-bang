import { bangCompletionSource } from "./bang-complete";
import { getCMModules } from "./cm-modules";
import {
  CONTROL_KEYWORDS,
  MODIFIER_KEYWORDS,
  WORD_OPERATORS,
  INSTRUCTIONS,
  CONSTANTS,
} from "./bang-tm-tokens.generated";

/**
 * Bang (mindustry_logic_bang_lang) 语法定义
 *
 * 关键点 1：语言扩展必须用 LanguageSupport 包装（Acode 的 getLanguageParser
 *   通过 `"language" in ext` 取解析器，裸 StreamLanguage 会被判为无解析器）。
 * 关键点 2：必须优先使用 Acode 自带的 CodeMirror 模块实例（见 cm-modules.ts）。
 * 关键点 3：词表来自上游官方 TextMate 语法（tools/gen-tm-grammar.mjs 生成），
 *   与 VSCode 官方扩展的高亮严格一致，不再手抄。
 *
 * 与官方语法的两处有意差异：
 *   - `Name!`（宏调用，如 For! / CountLoop!）整体标为 macro，官方把 `!` 算作
 *     constant.language。语义上 macro 更准确。
 *   - 数字的符号（`-5`）只在非标识符上下文才并入数字，避免 `a-5` 被误判。
 */

const keywordSet = new Set([...CONTROL_KEYWORDS, ...MODIFIER_KEYWORDS, ...WORD_OPERATORS]);
const instructionSet = new Set(INSTRUCTIONS);
const constantSet = new Set(CONSTANTS);

export const BANG_EXTENSIONS = ["mdtlbl", "mdtl"];
export const BANG_MODE_NAME = "bang";
export const BANG_MODE_CAPTION = "Mindustry Bang";

/** 官方 language-configuration.json 的括号集 */
const BRACKETS = ["()", "[]", "{}", '""', "''", "``"];

function buildTokenTable(tags: any) {
  return {
    comment: tags.comment,
    string: tags.string,
    number: tags.number,
    keyword: tags.keyword,
    instruction: tags.operatorKeyword,
    builtin: tags.standard(tags.variableName),
    constantVar: tags.constant(tags.variableName),
    constant: tags.constant(tags.name),
    macro: tags.macroName,
    label: tags.labelName,
    variable: tags.variableName,
    operator: tags.operator,
  };
}

interface BangStreamState {
  /** 未闭合的块注释：doc = `#**…*#`，block = `#*…*#` */
  block: null | "doc" | "block";
  /** 未闭合的字符串定界符（" 或 '） */
  str: null | string;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\\\u4e00-\u9fff]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_.\-\u4e00-\u9fff]/.test(ch);
}

/** 从当前位置扫到 quote 闭合；跨行时返回 false 交给下一行继续 */
function scanString(stream: any, quote: string): boolean {
  while (!stream.eol()) {
    const c = stream.next();
    if (c === "\\") {
      if (!stream.eol()) stream.next();
      continue;
    }
    if (c === quote) return true;
  }
  return false;
}

function makeToken() {
  return function token(stream: any, state: BangStreamState): string | null {
    // 1) 续接未闭合的块注释
    if (state.block) {
      if (stream.skipTo("*#")) stream.match("*#");
      else stream.skipToEnd();
      const tail = stream.string.slice(Math.max(0, stream.pos - 2), stream.pos);
      if (tail === "*#") state.block = null;
      return "comment";
    }

    // 2) 续接未闭合的字符串
    if (state.str) {
      const quote = state.str;
      if (scanString(stream, quote)) state.str = null;
      return "string";
    }

    if (stream.eatSpace()) return null;
    const ch = stream.peek();

    // 3) 注释：`#**#` 空文档块 / `#**…*#` 文档块 / `#*…*#` 块 / `#…` 行
    if (ch === "#") {
      if (stream.match("#**#")) return "comment";
      if (stream.match(/#\*\*(?!#)/)) {
        if (stream.skipTo("*#")) stream.match("*#");
        else {
          stream.skipToEnd();
          state.block = "doc";
        }
        return "comment";
      }
      if (stream.match("#*")) {
        if (stream.skipTo("*#")) stream.match("*#");
        else {
          stream.skipToEnd();
          state.block = "block";
        }
        return "comment";
      }
      stream.skipToEnd();
      return "comment";
    }

    // 4) 字符串（双引号 / 单引号，均可跨行）
    if (ch === '"' || ch === "'") {
      stream.next();
      state.str = ch;
      if (scanString(stream, ch)) state.str = null;
      return "string";
    }

    // 5) 标签：`:name` 或 `:'name'`
    if (ch === ":") {
      if (stream.match(/^:'[^']*'/)) return "label";
      if (stream.match(/^:[\w-]+/)) return "label";
    }

    // 6) 内置对象 `@name`，裸 `@` 是常量
    if (ch === "@") {
      if (stream.match(/^@[\w-]+/)) return "builtin";
      stream.next();
      return "constant";
    }

    // 7) `$`、反引号、`..`、`->`：官方 special-constants
    if (ch === "$" || ch === "`") {
      stream.next();
      return "constant";
    }
    if (stream.match(/^\.\./)) return "constant";
    if (stream.match(/^->/)) return "constant";

    // 8) 数字（0x / 0b / 十进制，支持下划线与指数）
    const prev = stream.string.charAt(stream.pos - 1);
    const signOk = (ch === "-" || ch === "+") && !/[\w)\]`'"]/.test(prev);
    if (/\d/.test(ch) || signOk) {
      if (stream.match(/^[+-]?0x[+-]?[\da-fA-F_]+/)) return "number";
      if (stream.match(/^[+-]?0b[+-]?[01_]+/)) return "number";
      if (stream.match(/^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/)) return "number";
    }

    // 9) 单词：关键字 / 指令 / 常量 / 变量
    if (isIdentStart(ch)) {
      const start = stream.pos;
      stream.next();
      while (!stream.eol() && isIdentChar(stream.peek())) stream.next();
      const word = stream.string.slice(start, stream.pos);

      if (stream.peek() === "!") {
        stream.next();
        return "macro";
      }
      if (instructionSet.has(word)) return "instruction";
      if (keywordSet.has(word)) return "keyword";
      if (constantSet.has(word)) return "constant";
      // 大写开头或 `_1` 形式按常量高亮（官方 variable 规则的第一个分支）
      if (/^[A-Z]/.test(word) || /^_\d/.test(word)) return "constantVar";
      return "variable";
    }

    // 10) 运算符
    if (
      stream.match(
        /^(?:\+\+|--|&&|\|\||=>|<<|>>>?|[+\-*/%|&^]=|==|!=|<=|>=|[=<>+\-*/%|&^~!?])/,
      )
    ) {
      return "operator";
    }
    if (stream.match(/^[(),;\[\]{}]/)) return "operator";

    stream.next();
    return null;
  };
}

let cachedExtensions: any[] | null = null;

/** 构建语言扩展，使用 Acode 的 CodeMirror 实例。
 *  补全通过 languageData 提供（Acode 已全局启用 autocompletion，
 *  这是官方认可的插件补全方式；插件无需再插一个 autocompletion 扩展）。 */
export function bangExtensions(): any[] {
  if (cachedExtensions) return cachedExtensions;
  const mods = getCMModules();
  const bangLanguage = mods.language.StreamLanguage.define({
    name: "bang",
    startState: (): BangStreamState => ({ block: null, str: null }),
    token: makeToken() as never,
    tokenTable: buildTokenTable(mods.highlight.tags),
    languageData: {
      // 官方 language-configuration.json：行注释 `#`，块注释 `#* … *#`
      commentTokens: { line: "#", block: { open: "#*", close: "*#" } },
      closeBrackets: { brackets: BRACKETS },
      // 让 `@unit`、`setrule.pauseDisabled` 这类标识符整体选中
      wordChars: "@.-$!\\",
    },
  } as never);
  const support = new mods.language.LanguageSupport(bangLanguage, [
    bangLanguage.data.of({ autocomplete: bangCompletionSource as never }),
  ]);
  cachedExtensions = [support];
  return cachedExtensions;
}
