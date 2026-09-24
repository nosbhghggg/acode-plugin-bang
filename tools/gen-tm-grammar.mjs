/**
 * 从上游 tmLanguage 语法文件提取高亮词表
 *
 * 输入：upstream/mdtlbl.tmLanguage.json（官方 VSCode 扩展的 TextMate 语法）
 * 输出：src/lang/bang-tm-tokens.generated.ts
 *
 * TextMate 语法依赖 Oniguruma 正则，CodeMirror 6 用不了；但其中真正的"词表"
 * （关键字、指令、字面运算符）可以完整提取出来，剩下的结构性规则（字符串、
 * 注释、标签、数字）由 bang-mode.ts 的 tokenizer 手写实现。
 *
 * 这样高亮的词表与官方语法严格一致，上游改词表 → 重跑本脚本即可跟上。
 *
 * 用法：node tools/gen-tm-grammar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcFile = path.join(root, "upstream", "mdtlbl.tmLanguage.json");
const outFile = path.join(root, "src", "lang", "bang-tm-tokens.generated.ts");

if (!fs.existsSync(srcFile)) {
  console.error(`找不到 ${srcFile}，请先运行 node tools/sync-upstream.mjs`);
  process.exit(1);
}

const grammar = JSON.parse(fs.readFileSync(srcFile, "utf8"));
const repo = grammar.repository ?? {};

/** 从 `\\b(a|b|c)\\b` 形式的 match 里取出词表 */
function wordsFrom(pattern, label) {
  if (!pattern) {
    console.error(`语法文件里找不到 ${label}`);
    process.exit(1);
  }
  const m = /^\\b\((.+)\)\\b$/.exec(pattern.match);
  if (!m) {
    console.error(`${label} 的 match 不是预期的 \\b(...)\\b 形式：${pattern.match}`);
    process.exit(1);
  }
  return m[1].split("|").filter(Boolean);
}

function patternsNamed(section, name) {
  return (repo[section]?.patterns ?? []).filter((p) => p.name === name);
}

const keywords = repo.keywords?.patterns ?? [];
const controlPat = keywords.find((p) => p.name === "keyword.control.mdtlbl" && p.match?.startsWith("\\b("));
const instructionPat = keywords.find((p) => p.name === "entity.name.function.mdtlbl");
const modifiers = patternsNamed("keywords", "storage.modifier.mdtlbl");

// storage.modifier 有两条：`const|set|inline` 与 `equal|lessThan|add|...`
const modifierWords = modifiers.map((p) => wordsFrom(p, "storage.modifier")).filter((w) => w.length <= 8);
const operatorWords = modifiers.map((p) => wordsFrom(p, "storage.modifier")).filter((w) => w.length > 8);

if (operatorWords.length !== 1 || modifierWords.length !== 1) {
  console.error(
    `预期 storage.modifier 恰好两条（关键词表 / 运算符表），实际 ${modifiers.length} 条，词数分别为 ` +
      `${modifierWords.map((w) => w.length).join(", ")}。上游语法可能已改结构，请检查后调整本脚本。`,
  );
  process.exit(1);
}

const constants = wordsFrom(
  (repo["special-constants"]?.patterns ?? []).find((p) => p.match?.includes("true|false")),
  "special-constants",
);

const CONTROL_KEYWORDS = wordsFrom(controlPat, "keyword.control");
const INSTRUCTIONS = wordsFrom(instructionPat, "entity.name.function");
const MODIFIER_KEYWORDS = modifierWords[0];
const WORD_OPERATORS = operatorWords[0];

const arr = (list) =>
  "[\n" + list.map((w) => `  ${JSON.stringify(w)},`).join("\n") + "\n]";

const out = `/**
 * 自动生成，请勿手动修改（tools/gen-tm-grammar.mjs）
 * 数据来源：upstream/mdtlbl.tmLanguage.json（上游 A4-Tacks/mindustry_logic_bang_lang 官方语法）
 *
 * 只提取词表；字符串 / 注释 / 标签 / 数字等结构性规则在 bang-mode.ts 里手写实现。
 */

/** 控制流关键字（官方 keyword.control.mdtlbl） */
export const CONTROL_KEYWORDS: readonly string[] = ${arr(CONTROL_KEYWORDS)};

/** 修饰关键字（官方 storage.modifier.mdtlbl 之一：const / set / inline） */
export const MODIFIER_KEYWORDS: readonly string[] = ${arr(MODIFIER_KEYWORDS)};

/** 字面运算符（官方 storage.modifier.mdtlbl 之二：equal / lessThan / add …） */
export const WORD_OPERATORS: readonly string[] = ${arr(WORD_OPERATORS)};

/** mlog 指令名（官方 entity.name.function.mdtlbl） */
export const INSTRUCTIONS: readonly string[] = ${arr(INSTRUCTIONS)};

/** 语言常量（官方 special-constants：true / false / null / noop） */
export const CONSTANTS: readonly string[] = ${arr(constants)};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out, "utf8");

console.log(`[gen-tm-grammar] → ${path.relative(root, outFile)}`);
console.log(
  `  控制关键字 ${CONTROL_KEYWORDS.length} · 修饰 ${MODIFIER_KEYWORDS.length} · ` +
    `字面运算符 ${WORD_OPERATORS.length} · 指令 ${INSTRUCTIONS.length} · 常量 ${constants.length}`,
);
