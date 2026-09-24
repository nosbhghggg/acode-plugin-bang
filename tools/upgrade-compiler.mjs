/**
 * 升级内置 Bang 编译器（上游 A4-Tacks/mindustry_logic_bang_lang）
 *
 * 做了什么：
 *   1. 可选：拉取上游指定 tag/分支（默认当前工作区状态，不自动改代码）
 *   2. 用 Rust 重新编译 tools/bang-wasm → wasm32
 *   3. 用 wasm-bindgen 生成 JS 胶水到插件 src/wasm
 *   4. 重新生成 base64 内嵌资源
 *
 * 用法：
 *   node tools/upgrade-compiler.mjs                 # 用当前上游代码重建
 *   node tools/upgrade-compiler.mjs v0.23.0         # 先切到指定 tag 再重建
 *   node tools/upgrade-compiler.mjs --check         # 只检查上游是否有新版本
 *
 * 环境变量（默认值见下，可按需覆盖）：
 *   RUST_BIN_DIR    rustc/cargo 所在目录
 *   WASM_BINDGEN    wasm-bindgen 可执行文件路径
 *   UPSTREAM_DIR    上游仓库路径
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const workspace = path.resolve(root, "..");

const UPSTREAM_DIR =
  process.env.UPSTREAM_DIR || path.join(workspace, "mindustry_logic_bang_lang");
const RUST_BIN_DIR =
  process.env.RUST_BIN_DIR || "D:\\tool or code environment\\rust\\toolchain";
const WASM_BINDGEN =
  process.env.WASM_BINDGEN ||
  "D:\\tool or code environment\\wasm-bindgen\\wasm-bindgen-0.2.128-x86_64-pc-windows-msvc\\wasm-bindgen.exe";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });

function log(msg) {
  console.log(`\n=== ${msg} ===`);
}

function upstreamVersion() {
  const toml = fs.readFileSync(path.join(UPSTREAM_DIR, "Cargo.toml"), "utf8");
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : "unknown";
}

function assertExists(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`找不到${what}：${p}\n可通过环境变量覆盖路径后重试。`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const tag = args.find((a) => !a.startsWith("--"));

log("环境检查");
assertExists(UPSTREAM_DIR, "上游仓库目录");
console.log(`上游仓库：${UPSTREAM_DIR}`);
console.log(`上游版本：${upstreamVersion()}`);
if (!checkOnly) {
  assertExists(path.join(RUST_BIN_DIR, "rustc", "bin", "rustc.exe"), "rustc");
  assertExists(WASM_BINDGEN, "wasm-bindgen CLI");
}

if (checkOnly) {
  console.log("\n（--check 模式：仅显示当前上游版本，未做任何改动）");
  process.exit(0);
}

if (tag) {
  log(`切换上游到 ${tag}`);
  run("git", ["fetch", "--all", "--tags"], { cwd: UPSTREAM_DIR });
  run("git", ["checkout", tag], { cwd: UPSTREAM_DIR });
  console.log(`当前上游版本：${upstreamVersion()}`);
}

const env = {
  ...process.env,
  PATH: `${path.join(RUST_BIN_DIR, "rustc", "bin")};${path.join(RUST_BIN_DIR, "cargo", "bin")};${process.env.PATH}`,
  CARGO_HOME: process.env.CARGO_HOME || "D:\\tool or code environment\\rust\\cargo-home",
  // 用独立 target 目录，避开上游仓库 target/ 下偶发的文件占用问题
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR || "D:\\tool or code environment\\rust\\bang-target",
};

const wasmDir = path.join(env.CARGO_TARGET_DIR, "wasm32-unknown-unknown", "release");

log("编译 bang-wasm → wasm32");
assertExists(path.join(UPSTREAM_DIR, "tools", "bang-wasm", "Cargo.toml"), "bang-wasm crate");

/** 该机器上构建产出的锁文件常被短暂保护，先尽力清理；失败则换全新 target 目录 */
function clearCargoLock(targetDir) {
  const lock = path.join(targetDir, "release", ".cargo-build-lock");
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(lock, { force: true });
      return true;
    } catch {
      const until = Date.now() + 1200;
      while (Date.now() < until) {
        /* wait */
      }
    }
  }
  return false;
}

function buildWasm(targetDir) {
  run(
    "cargo",
    ["build", "-p", "bang-wasm", "--target", "wasm32-unknown-unknown", "--release"],
    { cwd: UPSTREAM_DIR, env: { ...env, CARGO_TARGET_DIR: targetDir } },
  );
}

let targetDir = env.CARGO_TARGET_DIR;
clearCargoLock(targetDir);
try {
  buildWasm(targetDir);
} catch {
  targetDir = `${env.CARGO_TARGET_DIR}-${Date.now()}`;
  console.warn(`默认 target 目录被占用，改用全新目录：${targetDir}`);
  buildWasm(targetDir);
}
env.CARGO_TARGET_DIR = targetDir;
console.log(`target 目录：${targetDir}`);

const wasmPath = path.join(wasmDir, "bang_wasm.wasm");
assertExists(wasmPath, "编译产物 bang_wasm.wasm");

log("生成 JS 胶水到插件");
const outDir = path.join(root, "src", "wasm");
run(WASM_BINDGEN, [wasmPath, "--out-dir", outDir, "--target", "web"], { env });

log("重新生成 base64 内嵌资源");
run("node", [path.join(__dirname, "gen-wasm-assets.mjs")], { env });

log("完成");
console.log(`上游编译器版本：${upstreamVersion()}`);
console.log("下一步：npm run build    （重新打包 plugin.zip）");
