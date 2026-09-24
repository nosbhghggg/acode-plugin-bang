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
  decompile_mlog as wasmDecompileMlog,
} from "../wasm/bang_wasm.js";
import { bangWasmBase64 } from "../generated/wasm-assets";

export interface CompileResult {
  ok: boolean;
  output: string;
  error: string;
}

/** 暴力重建控制流的一个候选结果 */
export interface DecompileCase {
  index: number;
  /** 质量损失，越小越好 */
  loss: number;
  labels_def: number;
  labels_used: number;
  /** 逻辑风格伪代码（goto/if/else/do-while/gswitch） */
  logic: string;
  /** 原始格式（jump/skip/while/break/gswitch） */
  bang: string;
}

export interface DecompileResult {
  ok: boolean;
  error: string;
  /** 实际迭代次数（收敛会提前结束） */
  iterations: number;
  /** 输入逻辑行数 */
  lines: number;
  /** 迭代产生过的候选总数 */
  candidates: number;
  cases: DecompileCase[];
}

export interface DecompileOptions {
  /** 迭代次数，1..=64，越大质量越高越慢 */
  iterations: number;
  /** 每轮保留的最优候选数，20..=1500，越大越慢越占内存 */
  limit: number;
  /** 输出候选个数，1..=10 */
  outLimit: number;
  /** 指导模式：更激进，嵌套更深 */
  guidance: boolean;
}

/** 手机端默认参数：12 轮 / 200 候选，兼顾质量与耗时 */
export const DECOMPILE_DEFAULTS: DecompileOptions = {
  iterations: 12,
  limit: 200,
  outLimit: 3,
  guidance: false,
};

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

/**
 * 暴力重建控制流：把一串 jump / @counter 归约成 do-while / if-else / gswitch 等结构
 * 内核为上游 mlog-decompiler；参数会被 wasm 侧钳制到安全范围，不会抛异常
 */
export async function decompileMlog(
  source: string,
  options?: Partial<DecompileOptions>,
): Promise<DecompileResult> {
  ensureReady();
  const opt: DecompileOptions = { ...DECOMPILE_DEFAULTS, ...(options || {}) };
  const json = wasmDecompileMlog(
    source,
    opt.iterations,
    opt.limit,
    opt.outLimit,
    opt.guidance,
  );
  return JSON.parse(json) as DecompileResult;
}
