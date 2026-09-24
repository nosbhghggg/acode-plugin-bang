/**
 * bang-core: WASM 编译驱动（主通道）
 * 编译器为 tools/bang-wasm（bang 官方语法库的 wasm 绑定），随插件内置、离线可用。
 * wasm 以 base64 内嵌进 JS，初始化不依赖任何 fetch/文件请求
 * （Acode 真机插件目录是 cdvfile:// 协议，fetch 不可靠）。
 */
import {
  initSync,
  compile as wasmCompile,
  try_compile as wasmTryCompile,
  lint as wasmLint,
  version as wasmVersion,
} from "../wasm/bang_wasm.js";
import { bangWasmBase64 } from "../generated/wasm-assets";

export interface CompileResult {
  ok: boolean;
  output: string;
  error: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let ready = false;

/** 初始化 WASM（同步，使用内嵌字节） */
export function ensureReady(): void {
  if (ready) return;
  const bytes = base64ToBytes(bangWasmBase64);
  initSync({ module: bytes });
  ready = true;
}

/** 兼容旧调用签名（baseUrl 已不再需要） */
export function setBaseUrl(_url: string): void {
  /* noop：wasm 已内嵌 */
}

export async function compile(source: string, modes: string): Promise<string> {
  ensureReady();
  return wasmCompile(source, modes);
}

export async function tryCompile(
  source: string,
  modes: string,
): Promise<CompileResult> {
  ensureReady();
  return JSON.parse(wasmTryCompile(source, modes)) as CompileResult;
}

export async function lint(source: string): Promise<string> {
  ensureReady();
  return wasmLint(source);
}

export async function compilerVersion(): Promise<string> {
  ensureReady();
  return wasmVersion();
}
