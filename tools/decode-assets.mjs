/**
 * 从 assets/icon.png.b64 还原 icon.png
 * 说明：GitHub 连接器只支持推送文本文件，故二进制图标以 base64 入库；
 * CI 与本地开发都可用本脚本还原（已存在则跳过，除非 --force）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const b64Path = path.join(root, "assets", "icon.png.b64");
const outPath = path.join(root, "icon.png");
const force = process.argv.includes("--force");

if (!fs.existsSync(b64Path)) {
  console.error("缺少 assets/icon.png.b64");
  process.exit(1);
}
if (fs.existsSync(outPath) && !force) {
  console.log("[decode-assets] icon.png 已存在，跳过");
  process.exit(0);
}
fs.writeFileSync(outPath, Buffer.from(fs.readFileSync(b64Path, "utf8"), "base64"));
console.log("[decode-assets] icon.png 已还原");
