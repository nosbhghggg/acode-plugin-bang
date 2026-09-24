/**
 * 从上游快照生成 Bang 代码片段常量
 *
 * 输入：upstream/snippets.json（官方 VSCode 扩展的 381 条片段，VSCode 占位符语法）
 * 输出：src/lang/bang-snippets.generated.ts
 *
 * 占位符语法需要从 VSCode 转成 CodeMirror 6：
 *   ${1} / ${1:默认值}  —— 两者语法一致，原样保留
 *   裸 $1 / $0          —— CM6 只认花括号形式，需补成 ${1} / ${0}
 *   \$                  —— VSCode 的字面美元转义，CM6 里 $ 本身不特殊，还原为 $
 *
 * 用法：node tools/gen-snippets.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcFile = path.join(root, "upstream", "snippets.json");
const outFile = path.join(root, "src", "lang", "bang-snippets.generated.ts");

if (!fs.existsSync(srcFile)) {
  console.error(`找不到 ${srcFile}，请先运行 node tools/sync-upstream.mjs`);
  process.exit(1);
}

/** VSCode 片段模板 → CodeMirror 6 片段模板 */
function toCmTemplate(body) {
  return body
    .join("\n")
    .replace(/\\\$/g, "$")          // \$ → $
    .replace(/\$(?!\{)(\d+)/g, "${$1}"); // 裸 $1 → ${1}
}

const raw = JSON.parse(fs.readFileSync(srcFile, "utf8"));
const entries = [];

for (const [name, def] of Object.entries(raw)) {
  const prefixes = Array.isArray(def.prefix) ? def.prefix : [def.prefix];
  const template = toCmTemplate(def.body ?? []);
  const detail = def.description || name;
  for (const prefix of prefixes) {
    if (typeof prefix !== "string" || !prefix) continue;
    entries.push([prefix, detail, template]);
  }
}

// 稳定排序：prefix 短的在前，便于补全列表里短前缀优先命中
entries.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));

const header = `/**
 * 自动生成，请勿手动修改（tools/gen-snippets.mjs）
 * 数据来源：upstream/snippets.json（上游 A4-Tacks/mindustry_logic_bang_lang 官方片段）
 *
 * 每项为 [前缀, 说明, CodeMirror 片段模板]。
 * 模板里的 \${1} / \${1:默认} 由 CM6 的 snippetCompletion 处理成可 Tab 跳转的占位符。
 */

/** [前缀, 说明, 模板] */
export type BangSnippet = readonly [label: string, detail: string, template: string];

/** 官方片段总数（生成时固定，供回归测试比对） */
export const BANG_SNIPPET_COUNT = ${entries.length};

export const BANG_SNIPPETS: readonly BangSnippet[] = [
`;

const body = entries
  .map(([label, detail, template]) => `  [${JSON.stringify(label)}, ${JSON.stringify(detail)}, ${JSON.stringify(template)}],`)
  .join("\n");

const footer = `\n];\n`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, header + body + footer, "utf8");

const size = fs.statSync(outFile).size;
console.log(`[gen-snippets] ${entries.length} 条片段 → ${path.relative(root, outFile)} (${(size / 1024).toFixed(1)} KB)`);
