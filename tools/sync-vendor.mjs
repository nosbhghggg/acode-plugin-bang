/**
 * 把 npm 依赖里的 brotli-wasm 同步到 src/vendor/（构建用，CI 与本地一致）
 * 说明：此处 vendored 是为了让 import 路径稳定、且不依赖包導出映射（exports）细节。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "node_modules", "brotli-wasm");
const dest = path.join(root, "src", "vendor", "brotli-wasm");

if (!fs.existsSync(src)) {
  console.error("未找到 node_modules/brotli-wasm，请先 npm ci / npm i brotli-wasm");
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

copyDir(src, dest);
console.log(`[sync-vendor] brotli-wasm → src/vendor/brotli-wasm`);
