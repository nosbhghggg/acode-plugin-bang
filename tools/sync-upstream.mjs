/**
 * 同步上游产物快照（A4-Tacks/mindustry_logic_bang_lang）
 *
 * 插件不修改上游任何源码：本脚本只把上游现成产物抓下来、校验 sha256、冻结到 upstream/。
 * 下游由各自的生成器消费：
 *   mdtlbl.tmLanguage.json   → tools/gen-tm-grammar.mjs
 *   snippets.json            → tools/gen-snippets.mjs
 *   language-configuration.json → src/lang/bang-mode.ts（手抄为常量）
 *
 * 用法：
 *   node tools/sync-upstream.mjs                # 抓取并校验（本地仓库优先）
 *   node tools/sync-upstream.mjs --check        # 只校验现有快照，不联网、不写盘
 *   node tools/sync-upstream.mjs --remote       # 跳过本地仓库，强制从 GitHub 抓
 *   node tools/sync-upstream.mjs --tag v0.23.0  # 指定 tag 抓取（同时更新 SOURCE.json）
 *
 * 环境变量：
 *   UPSTREAM_DIR   本地上游仓库路径（默认 ../mindustry_logic_bang_lang）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const upstreamDir = path.join(root, "upstream");
const sourceFile = path.join(upstreamDir, "SOURCE.json");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const forceRemote = args.includes("--remote");
const tagArg = (() => {
  const i = args.indexOf("--tag");
  return i >= 0 ? args[i + 1] : null;
})();

const LOCAL_REPO =
  process.env.UPSTREAM_DIR || path.resolve(root, "..", "mindustry_logic_bang_lang");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readSource() {
  if (!fs.existsSync(sourceFile)) {
    console.error(`找不到 ${sourceFile}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(sourceFile, "utf8"));
}

const source = readSource();
const tag = tagArg || source.tag;
const repo = source.repository;
const repoSlug = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

/**
 * 与 compiler/upstream.json 的 tag 交叉校验。
 * 两处 pin 的是同一份上游，必须同步升级，否则会出现「wasm 是新版、片段是旧版」的隐性漂移。
 */
const compilerPinFile = path.join(root, "compiler", "upstream.json");
function compilerPinnedTag() {
  if (!fs.existsSync(compilerPinFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(compilerPinFile, "utf8")).tag ?? null;
  } catch {
    return null;
  }
}
const compilerTag = compilerPinnedTag();
const tagMismatch = compilerTag !== null && compilerTag !== tag;

console.log(`上游仓库：${repo}`);
console.log(`目标 tag：${tag}${compilerTag ? `（compiler/upstream.json 为 ${compilerTag}）` : ""}`);

if (tagMismatch) {
  const msg =
    `\n[tag 漂移] upstream/SOURCE.json = ${tag}，compiler/upstream.json = ${compilerTag}。\n` +
    `两者 pin 的应是同一份上游。升级时请同步执行：\n` +
    `  node tools/sync-upstream.mjs --tag ${compilerTag} && node tools/gen-snippets.mjs && node tools/gen-tm-grammar.mjs\n`;
  if (checkOnly) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

// ---------- --check：只校验现有快照 ----------

if (checkOnly) {
  let bad = 0;
  for (const f of source.files) {
    const p = path.join(upstreamDir, f.local);
    if (!fs.existsSync(p)) {
      console.error(`  [缺失] ${f.local}`);
      bad++;
      continue;
    }
    const got = sha256(fs.readFileSync(p));
    if (got !== f.sha256) {
      console.error(`  [不匹配] ${f.local}\n    期望 ${f.sha256}\n    实际 ${got}`);
      bad++;
    } else {
      console.log(`  [ok] ${f.local}`);
    }
  }
  if (bad) {
    console.error(`\n快照校验失败：${bad} 个文件异常。运行 node tools/sync-upstream.mjs 重新抓取。`);
    process.exit(1);
  }
  console.log("\n快照校验通过（未联网、未写盘）。");
  process.exit(0);
}

// ---------- 取内容：本地仓库优先，回落 GitHub raw ----------

/**
 * 本地仓库没有 git 可用时也能工作：直接按 SOURCE.json 的 source 相对路径读文件。
 * 若本地仓库不存在 / 指定 --remote，则走 raw.githubusercontent.com。
 */
async function fetchFile(f) {
  const localPath = path.join(LOCAL_REPO, f.source);
  if (!forceRemote && fs.existsSync(localPath)) {
    return { buf: fs.readFileSync(localPath), from: `local:${localPath}` };
  }
  const url = `https://raw.githubusercontent.com/${repoSlug}/${tag}/${f.source}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`抓取失败 ${res.status} ${res.statusText}\n  ${url}`);
  }
  return { buf: Buffer.from(await res.arrayBuffer()), from: `remote:${url}` };
}

// ---------- 主流程 ----------

let changed = 0;
const nextFiles = [];

for (const f of source.files) {
  let got;
  try {
    got = await fetchFile(f);
  } catch (e) {
    console.error(`\n${f.local}: ${e.message}`);
    console.error("提示：可先 git clone 上游仓库，或用 UPSTREAM_DIR 指向本地副本。");
    process.exit(1);
  }

  const digest = sha256(got.buf);
  const expected = tagArg ? null : f.sha256;

  if (expected && digest !== expected) {
    console.error(
      `\n[哈希不匹配] ${f.local}\n  期望 ${expected}\n  实际 ${digest}\n  ` +
        `来源 ${got.from}\n\n` +
        `可能原因：上游在该 tag 上重新打了包，或本地副本不是该 tag。\n` +
        `确认无误后用 --tag ${tag} 重跑以更新 SOURCE.json。`,
    );
    process.exit(1);
  }

  const dest = path.join(upstreamDir, f.local);
  const before = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (!before || sha256(before) !== digest) {
    fs.writeFileSync(dest, got.buf);
    changed++;
    console.log(`  [更新] ${f.local}  ← ${got.from}`);
  } else {
    console.log(`  [不变] ${f.local}`);
  }

  nextFiles.push({ ...f, sha256: digest });
}

if (tagArg) {
  source.tag = tag;
  source.files = nextFiles;
  fs.writeFileSync(sourceFile, JSON.stringify(source, null, 2) + "\n", "utf8");
  console.log(`\nSOURCE.json 已更新（tag=${tag}）。`);
}

console.log(`\n完成：${changed} 个文件更新，快照目录 upstream/`);
if (!tagArg) {
  console.log("提示：SOURCE.json 里的 sha256 未改；如需随上游升级，请带 --tag 参数重跑。");
}
