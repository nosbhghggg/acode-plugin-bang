/**
 * bang-core: Bang 源码嵌入/还原（Brotli + base32768）
 * 移植自 nosbhghggg/mindustry-logic-bang-language-runner（MIT），逻辑保持一致：
 * 编译产物的 mlog 尾部追加 print ">DATA:<base32768(brotli(源码))>" 行，
 * 在游戏内复制 mlog 后可随时还原出原始 Bang 源码。
 * Brotli 实现为 brotli-wasm（Apache-2.0），与桌面端 zlib 产物互通。
 */

import brotliInit, {
  compress as brotliCompress,
  decompress as brotliDecompress,
} from "../vendor/brotli-wasm/pkg.web/brotli_wasm.js";
import { brotliWasmBase64 } from "../generated/wasm-assets";
import { base64ToBytes } from "./compiler-wasm";

const MAGIC = new Uint8Array([0x00, 0x42, 0x41, 0x4e, 0x47, 0x00]); // \x00BANG\x00
const CJK_BASE = 32768;
const CJK_OFFSET = 0x4e00;
const UNPACK_MAX_INPUT = 20 * 1024;
const UNPACK_MAX_OUTPUT = 30 * 1024;

let brotliReady: Promise<void> | null = null;

/** 兼容旧签名；brotli wasm 已内嵌，不需要 baseUrl */
export function setEmbedBaseUrl(_baseUrl: string): void {
  if (!brotliReady) {
    brotliReady = brotliInit(base64ToBytes(brotliWasmBase64)).then(() => undefined);
  }
}

async function ensureBrotli(): Promise<void> {
  if (!brotliReady) {
    // 调用方未显式初始化时兜底
    brotliReady = brotliInit(base64ToBytes(brotliWasmBase64)).then(() => undefined);
  }
  await brotliReady;
}

function textEncoder(): { encode(s: string): Uint8Array; decode(b: Uint8Array): string } {
  return {
    encode: (s) => new TextEncoder().encode(s),
    decode: (b) => new TextDecoder().decode(b),
  };
}

/** 字节流 → base32768（CJK 区字符），移植自 VSCode 插件 _baseEncode */
function baseEncode(buf: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    bits = (bits << 8) | buf[i];
    bitCount += 8;
    while (bitCount >= 15) {
      bitCount -= 15;
      s += String.fromCharCode(CJK_OFFSET + ((bits >>> bitCount) & 0x7fff));
    }
  }
  if (bitCount > 0) {
    s += String.fromCharCode(CJK_OFFSET + ((bits << (15 - bitCount)) & 0x7fff));
  }
  return s;
}

/** base32768 → 字节流，移植自 _baseDecode */
function baseDecode(s: string): Uint8Array {
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const idx = s.charCodeAt(i) - CJK_OFFSET;
    if (idx < 0 || idx >= CJK_BASE) continue;
    bits = (bits << 15) | idx;
    bitCount += 15;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** 压缩源码为可嵌入字符串；超过大小限制返回 null */
export async function packSource(src: string): Promise<string | null> {
  await ensureBrotli();
  const raw = new Uint8Array(MAGIC.length + src.length);
  raw.set(MAGIC, 0);
  raw.set(textEncoder().encode(src), MAGIC.length);
  const packed = brotliCompress(raw, { quality: 11 });
  if (!packed) return null;
  const encoded = baseEncode(packed);
  return encoded.length > UNPACK_MAX_INPUT ? null : encoded;
}

/** 从嵌入字符串还原源码；失败抛错 */
export async function unpackSource(encoded: string): Promise<string> {
  await ensureBrotli();
  if (encoded.length > UNPACK_MAX_INPUT) throw new Error("input too large");
  const buf = baseDecode(encoded);
  const out = brotliDecompress(buf);
  if (!out || out.length > UNPACK_MAX_OUTPUT) throw new Error("output too large");
  for (let i = 0; i < MAGIC.length; i++) {
    if (out[i] !== MAGIC[i]) throw new Error("bad magic");
  }
  return textEncoder().decode(out.slice(MAGIC.length));
}

/** mlog 尾部追加嵌入块（与桌面插件格式一致，可互相还原） */
export async function embedSource(
  compiled: string,
  src: string,
  compilerVer: string,
): Promise<string> {
  const data = await packSource(src);
  if (!data) return compiled;
  const ver = `MDTBL-R v0.2.0`;
  const lines = [
    `print ">DATE:${new Date().toISOString().slice(0, 10)}"`,
    `print "${compilerVer ? `${ver} | Bang wasm v${compilerVer}` : ver}"`,
    `print ">DATA:${data}"`,
  ];
  const mt = "\n" + lines.join("\n");
  const trimmed = compiled.trimEnd();
  return trimmed.endsWith("\nend") || trimmed === "end"
    ? compiled + mt
    : compiled + "\nend" + mt;
}

/** 异步版还原：确保 brotli 初始化后解析 */
export async function extractSource(mlog: string): Promise<string | null> {
  await ensureBrotli();
  const lines = mlog.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
    const m = lines[i].replace(/\r$/, "").match(/^print ">(.+)"/);
    if (!m) continue;
    const v = m[1];
    const k = v.split(":")[0];
    const val = v.slice(v.indexOf(":") + 1);
    if (k === "DATA") {
      try {
        return await unpackSource(val);
      } catch {
        return null;
      }
    }
  }
  return null;
}
