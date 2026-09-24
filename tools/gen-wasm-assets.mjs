/**
 * 构建前生成 wasm 内嵌资源（base64）
 * 目的：Acode 真机环境里 baseUrl 是 Cordova cdvfile:// 协议，fetch 可能不可用；
 * 内嵌后无需任何网络/文件请求即可初始化 wasm。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const sources = [
  {
    name: "bangWasmBase64",
    file: path.join(root, "src/wasm/bang_wasm_bg.wasm"),
  },
  {
    name: "brotliWasmBase64",
    file: path.join(root, "src/vendor/brotli-wasm/pkg.web/brotli_wasm_bg.wasm"),
  },
];

const outDir = path.join(root, "src/generated");
fs.mkdirSync(outDir, { recursive: true });

let out = `/**\n * 自动生成，请勿手动修改（tools/gen-wasm-assets.mjs）\n * 内嵌 wasm 的 base64，避免真机 cdvfile:// 环境下 fetch 失败\n */\n`;

for (const { name, file } of sources) {
  const b64 = fs.readFileSync(file).toString("base64");
  out += `export const ${name} = "${b64}";\n`;
  console.log(`[gen-wasm] ${name}: ${(b64.length / 1024 / 1024).toFixed(2)} MB base64`);
}

const outFile = path.join(outDir, "wasm-assets.ts");

// 该机器上已存在文件可能被短暂锁定，先尽力删除
for (let i = 0; i < 8; i++) {
  try {
    fs.rmSync(outFile, { force: true });
    break;
  } catch {
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      /* 简单等待后重试 */
    }
  }
}

fs.writeFileSync(outFile, out, "utf8");
console.log(`[gen-wasm] written to src/generated/wasm-assets.ts`);
