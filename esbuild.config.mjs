import * as esbuild from "esbuild";
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function serveUrls(hosts, port) {
  const names = new Set(
    (hosts?.length ? hosts : ["127.0.0.1"]).flatMap((host) => {
      if (host === "0.0.0.0" || host === "::") return ["127.0.0.1"];
      return [host.includes(":") ? `[${host}]` : host];
    }),
  );

  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.internal || net.family !== "IPv4") continue;
      names.add(net.address);
    }
  }

  return [...names].map((host) => `http://${host}:${port}`);
}

const isServe = process.argv.includes("--serve");

function packZip() {
  execFile(process.execPath, ["./pack-zip.js"], (err, stdout) => {
    if (err) {
      console.error("Error packing zip:", err);
      return;
    }
    console.log(stdout.trim());
  });
}

const zipPlugin = {
  name: "zip-plugin",
  setup(build) {
    build.onEnd(() => {
      packZip();
    });
  },
};

const copyWasm = {
  name: "copy-wasm",
  setup(build) {
    build.onEnd(() => {
      // wasm 已以 base64 内嵌进 main.js（见 tools/gen-wasm-assets.mjs），无需外置资源
      console.log("wasm embedded in main.js (no external assets)");
    });
  },
};

const buildConfig = {
  entryPoints: {
    main: "src/main.ts",
  },
  bundle: true,
  minify: true,
  platform: "browser",
  target: ["chrome90"],
  format: "iife",
  logLevel: "info",
  color: true,
  outdir: "build",
  loader: {
    ".wasm": "empty",
  },
  plugins: [copyWasm, zipPlugin],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 该机器上"已存在文件"常被短暂锁定（杀软/文件监控），这里做删除 + 重试自愈 */
async function removeWithRetry(target, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await sleep(1500);
    }
  }
}

async function buildWithRetry(tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      await removeWithRetry(path.join(__dirname, "build"));
      await esbuild.build(buildConfig);
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      console.warn(`[build] 第 ${i} 次失败（文件被占用），重试…`);
      if (i === tries) throw err;
      await sleep(2000);
    }
  }
}

(async function () {
  if (isServe) {
    console.log("Starting development server...");

    const ctx = await esbuild.context(buildConfig);
    await ctx.watch();
    const { hosts, port } = await ctx.serve({
      servedir: ".",
      port: 3000,
    });
    for (const url of serveUrls(hosts, port)) {
      console.log(`Development server: ${url}`);
    }
  } else {
    console.log("Building for production...");
    await buildWithRetry();
    console.log("Production build complete.");
  }
})();
