import plugin from "../plugin.json";
import {
  compile,
  tryCompile,
  lint,
  setBaseUrl,
  compilerVersion,
} from "./bang-core/compiler-wasm";
import {
  embedSource,
  extractSource,
  unpackSource,
  setEmbedBaseUrl,
} from "./bang-core/embed";
import {
  bangExtensions,
  BANG_EXTENSIONS,
  BANG_MODE_NAME,
  BANG_MODE_CAPTION,
} from "./lang/bang-mode";

const EMBED_KEY = "acode-plugin-bang.embedSource";

type MenuAction = { id: string; text: string };

const MENU_MDTLBL: MenuAction[] = [
  { id: "compile", text: "编译并保存 .logic" },
  { id: "preview", text: "编译并预览（不落盘）" },
  { id: "tag", text: "查看标签码（t）" },
  { id: "copy", text: "复制 mlog 到剪贴板" },
  { id: "clip", text: "从剪贴板导入 Bang 源码" },
];

const MENU_MLOG: MenuAction[] = [
  { id: "decompile", text: "反编译为 Bang 源码" },
  { id: "format", text: "格式化 mlog（原地）" },
  { id: "import", text: "导入嵌入的 Bang 源码" },
  { id: "clip", text: "从剪贴板导入 Bang 源码" },
];

class AcodePlugin {
  baseUrl = "";
  private registeredMode = false;
  private lintTimer: ReturnType<typeof setTimeout> | null = null;
  private sideBtn: { show(): void; hide(): void } | null = null;
  private sidebarAdded = false;
  private compilerVer = "";
  private cacheFileUrl = "";
  private listeners: Array<[string, () => void]> = [];

  /** loader 模块：Acode 的用法是 loader.create(title) / loader.destroy() */
  private showLoader(title: string): { destroy?(): void } {
    try {
      const loader = acode.require("loader") as any;
      if (typeof loader?.create === "function") {
        loader.create(title);
        return { destroy: () => loader.destroy?.() };
      }
      if (typeof loader?.show === "function") {
        loader.show();
        return { destroy: () => loader.hide?.() };
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  async init(
    _page: Acode.WCPage,
    _cacheFile: Acode.FileSystem,
    cacheFileUrl: string,
  ): Promise<void> {
    try {
      this.cacheFileUrl = cacheFileUrl || "";
      setBaseUrl(this.baseUrl);
      setEmbedBaseUrl(this.baseUrl);
      this.registerLanguage();
      this.registerCommands();
      this.registerHooks();
      this.registerSideButton();
      this.registerSidebarApp();
      window.toast(`Bang 插件已加载 v${plugin.version}`, 3000);
      // 预热编译器（后台，不阻塞 UI）
      void compilerVersion()
        .then((v) => {
          this.compilerVer = v;
          console.log("[bang] wasm compiler ready, version", v);
        })
        .catch((e) => {
          console.warn("[bang] wasm 预热失败（编译时仍会重试）", e);
        });
    } catch (e) {
      // 初始化失败必须可见，避免"什么都没发生"
      const msg = (e as Error).stack || String(e);
      console.error("[bang] init failed", e);
      try {
        acode.alert("Bang 插件初始化失败", msg.slice(0, 1500));
      } catch {
        /* ignore */
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.lintTimer) clearTimeout(this.lintTimer);
    try {
      const commands = acode.require("commands") as any;
      for (const name of [
        "bang.compile",
        "bang.compile-copy",
        "bang.decompile",
        "bang.lint",
        "bang.import-source",
        "bang.import-clipboard",
        "bang.toggle-embed",
        "bang.diagnose",
      ]) {
        commands?.removeCommand?.(name);
      }
    } catch {
      /* ignore */
    }
    for (const [event, listener] of this.listeners) {
      try {
        (acode.require("editorManager") as any)?.off?.(event, listener);
      } catch {
        /* ignore */
      }
    }
    try {
      this.sideBtn?.hide?.();
    } catch {
      /* ignore */
    }
    try {
      if (this.sidebarAdded) {
        (acode.require("sidebarApps") as any)?.remove?.("bang-panel");
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.registeredMode) {
        const editorLanguages = acode.require("editorLanguages") as any;
        editorLanguages?.unregister?.(BANG_MODE_NAME);
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- 注册 ----------

  private registerLanguage(): void {
    // 优先新版 API（CodeMirror）
    try {
      const editorLanguages = acode.require("editorLanguages") as any;
      if (editorLanguages?.register) {
        editorLanguages.register(
          BANG_MODE_NAME,
          BANG_EXTENSIONS,
          BANG_MODE_CAPTION,
          // 关键：返回带 language 字段的 LanguageSupport（含补全）
          async () => bangExtensions(),
        );
        this.registeredMode = true;
        return;
      }
    } catch (e) {
      console.warn("[bang] editorLanguages 注册失败", e);
    }
    // 老版本回退（Ace 时代 API，仅高亮关联）
    try {
      const aceModes = acode.require("aceModes") as any;
      if (aceModes?.addMode) {
        aceModes.addMode(BANG_MODE_NAME, BANG_EXTENSIONS, BANG_MODE_CAPTION);
        this.registeredMode = true;
      }
    } catch (e) {
      console.warn("[bang] aceModes 注册失败", e);
    }
  }

  private registerCommands(): void {
    const commands = acode.require("commands") as any;
    const defs: Array<[string, string, () => void]> = [
      ["bang.compile", "Bang: 编译当前文件（mlog 输出到新文件）", () => void this.actionCompile()],
      ["bang.compile-copy", "Bang: 编译并复制 mlog 到剪贴板", () => void this.actionCopy()],
      ["bang.decompile", "Bang: 反编译当前 mlog 为 Bang 源码", () => void this.actionDecompile()],
      ["bang.lint", "Bang: lint 检查当前文件", () => void this.actionLint()],
      ["bang.import-source", "Bang: 导入 mlog 中嵌入的源码", () => void this.actionImportSource()],
      ["bang.import-clipboard", "Bang: 从剪贴板导入 Bang 源码", () => void this.actionImportClipboard()],
      ["bang.toggle-embed", "Bang: 切换「mlog 嵌入源码」开关", () => this.actionToggleEmbed()],
      ["bang.diagnose", "Bang: 自检（诊断插件状态）", () => void this.actionDiagnose()],
    ];
    for (const [name, description, exec] of defs) {
      commands?.addCommand?.({
        name,
        description,
        // 不要求有活动编辑器：自检/切开关等命令在无文件时也要能用
        requiresView: false,
        exec: () => (exec(), true),
      });
    }
  }

  private registerHooks(): void {
    const editorManager = acode.require("editorManager") as any;
    const onSwitch = () => this.updateSideButton();
    const onSave = () => this.onSaveDebounced();
    editorManager?.on?.("switch-file", onSwitch);
    editorManager?.on?.("save-file", onSave);
    this.listeners.push(["switch-file", onSwitch], ["save-file", onSave]);
  }

  /** 侧边栏 Bang 面板：不依赖版本，入口永远可见 */
  private registerSidebarApp(): void {
    try {
      const sidebarApps = acode.require("sidebarApps") as any;
      if (!sidebarApps?.add) return;
      sidebarApps.add(
        "code",
        "bang-panel",
        "Bang",
        (container: HTMLElement) => this.renderPanel(container),
        false,
        (container: HTMLElement) => this.renderPanel(container),
      );
      this.sidebarAdded = true;
    } catch (e) {
      console.warn("[bang] sidebarApps 不可用", e);
    }
  }

  private renderPanel(container: HTMLElement): void {
    container.innerHTML = "";
    container.style.padding = "10px";

    const title = document.createElement("div");
    title.textContent = "Bang 工具";
    title.style.cssText =
      "font-size:14px;font-weight:500;margin-bottom:8px;color:var(--text-color,#ddd)";
    container.appendChild(title);

    const info = document.createElement("div");
    const active = this.getActiveFile();
    info.textContent = active?.filename
      ? `当前文件：${active.filename}`
      : "未打开文件";
    info.style.cssText = "font-size:12px;margin-bottom:10px;opacity:.75";
    container.appendChild(info);

    const status = document.createElement("pre");
    status.style.cssText =
      "font-size:11px;white-space:pre-wrap;margin-top:10px;opacity:.8;max-height:40vh;overflow:auto";

    const btn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "display:block;width:100%;margin:0 0 6px;padding:8px 10px;font-size:13px;" +
        "background:var(--secondary-color,#2a2a2a);color:var(--text-color,#ddd);" +
        "border:1px solid rgba(255,255,255,.12);border-radius:0;text-align:left;cursor:pointer";
      b.onclick = fn;
      container.appendChild(b);
    };

    const kind = this.activeKind();
    if (kind === "mdtlbl") {
      btn("编译并复制 mlog", () => void this.actionCopy());
      btn("编译并保存 .logic", () => void this.actionCompile());
      btn("编译并预览", () => void this.actionPreview());
      btn("从剪贴板导入源码", () => void this.actionImportClipboard());
    } else if (kind === "mlog") {
      btn("反编译为 Bang 源码", () => void this.actionDecompile());
      btn("格式化 mlog", () => void this.actionFormat());
      btn("导入嵌入的源码", () => void this.actionImportSource());
    } else {
      status.textContent = "打开 .mdtlbl 或 .mlog 文件后可用";
    }
    btn(`源码嵌入：${this.embedEnabled() ? "已开启" : "已关闭"}（点击切换）`, () =>
      this.actionToggleEmbed(),
    );
    btn("自检 / 诊断", () => void this.actionDiagnose());

    container.appendChild(status);
  }

  private registerSideButton(): void {
    const SideButton = acode.require("sideButton") as any;
    if (typeof SideButton !== "function") return; // Acode < v316
    this.sideBtn = SideButton({
      text: "Bang",
      icon: "code",
      onclick: () => void this.showActionsMenu(),
    });
    this.updateSideButton();
  }

  // ---------- 侧边按钮 ----------

  private activeKind(): "mdtlbl" | "mlog" | null {
    const editorManager = acode.require("editorManager") as any;
    const file = editorManager?.activeFile;
    if (!file) return null;
    const name: string = file.filename || "";
    if (/\.(mdtlbl|mdtl)$/i.test(name)) return "mdtlbl";
    if (/\.(mlog|logic)$/i.test(name)) return "mlog";
    return null;
  }

  private updateSideButton(): void {
    if (!this.sideBtn) return;
    this.activeKind() ? this.sideBtn.show() : this.sideBtn.hide();
  }

  private async showActionsMenu(): Promise<void> {
    const kind = this.activeKind();
    const menu = kind === "mdtlbl" ? MENU_MDTLBL : kind === "mlog" ? MENU_MLOG : [];
    if (!menu.length) {
      window.toast("当前文件不是 .mdtlbl 或 .mlog", 3000);
      return;
    }
    const select = acode.require("select") as any;
    const items = menu.map((m) => [m.id, m.text]);
    const chosen = await select("Bang 操作", items, { hideOnSelect: true });
    if (!chosen) return;
    const actions: Record<string, () => void> = {
      compile: () => void this.actionCompile(),
      preview: () => void this.actionPreview(),
      tag: () => void this.actionTag(),
      copy: () => void this.actionCopy(),
      decompile: () => void this.actionDecompile(),
      format: () => void this.actionFormat(),
      import: () => void this.actionImportSource(),
      clip: () => void this.actionImportClipboard(),
    };
    actions[chosen]?.();
  }

  // ---------- 动作实现 ----------

  private embedEnabled(): boolean {
    return localStorage.getItem(EMBED_KEY) !== "off";
  }

  private getActiveFile(): { filename: string; content: string; file: any } | null {
    const editorManager = acode.require("editorManager") as any;
    const file = editorManager?.activeFile;
    if (!file) return null;
    const content: string = file.session?.getValue?.() ?? file.content ?? "";
    return { filename: file.filename || "", content, file };
  }

  private async buildOutput(mlog: string, src: string): Promise<string> {
    if (!this.embedEnabled()) return mlog;
    try {
      return await embedSource(mlog, src, this.compilerVer);
    } catch {
      return mlog;
    }
  }

  /** 编译当前 .mdtbl → mlog */
  private async compileCurrent(): Promise<string | null> {
    const active = this.getActiveFile();
    if (!active || !active.content.trim()) {
      window.toast("请先打开非空的 Bang 源文件", 3000);
      return null;
    }
    const loader = this.showLoader("正在编译...");
    try {
      const mlog = await compile(active.content, "c");
      loader?.destroy?.();
      return mlog;
    } catch (e) {
      loader?.destroy?.();
      acode.alert("编译失败", String((e as Error).message).slice(0, 2000));
      return null;
    }
  }

  /** 编译并保存同名 .logic（带嵌入源码） */
  private async actionCompile(): Promise<void> {
    const active = this.getActiveFile();
    const mlog = await this.compileCurrent();
    if (mlog === null || !active) return;
    const output = await this.buildOutput(mlog, active.content);
    const name = active.filename.replace(/\.(mdtlbl|mdtl)$/i, "") + ".logic";
    await this.saveNextTo(active, name, output);
  }

  /** 编译并预览（新文件，不覆盖 .logic） */
  private async actionPreview(): Promise<void> {
    const mlog = await this.compileCurrent();
    if (mlog === null) return;
    const output = await this.buildOutput(mlog, this.getActiveFile()!.content);
    const n = mlog.trimEnd().split("\n").length;
    void this.openInNewFile(`preview-${Date.now()}.logic`, output);
    window.toast(`编译成功：${n} 条指令`, 3000);
  }

  /** 查看标签码（模式 t） */
  private async actionTag(): Promise<void> {
    const active = this.getActiveFile();
    if (!active) return;
    try {
      const tag = await compile(active.content, "t");
      void this.openInNewFile(`tags-${Date.now()}.mdttxt`, tag);
    } catch (e) {
      acode.alert("标签码生成失败", String((e as Error).message).slice(0, 2000));
    }
  }

  /** 编译并复制到剪贴板（带嵌入源码） */
  private async actionCopy(): Promise<void> {
    const active = this.getActiveFile();
    const mlog = await this.compileCurrent();
    if (mlog === null || !active) return;
    const output = await this.buildOutput(mlog, active.content);
    await this.copyToClipboard(output);
    const n = mlog.trimEnd().split("\n").length;
    window.toast(`已复制 ${n} 条指令（${this.embedEnabled() ? "含源码" : "未嵌入"}）`, 4000);
  }

  /** 反编译 .mlog/.logic → Bang */
  private async actionDecompile(): Promise<void> {
    const active = this.getActiveFile();
    if (!active) return;
    if (!/\.(mlog|logic)$/i.test(active.filename)) {
      window.toast("反编译仅支持 .mlog / .logic 文件", 3000);
      return;
    }
    const loader = this.showLoader("正在反编译...");
    try {
      const result = await tryCompile(active.content, "r");
      loader?.destroy?.();
      if (!result.ok) {
        acode.alert("反编译失败", result.error.slice(0, 2000));
        return;
      }
      const name = active.filename.replace(/\.(mlog|logic)$/i, "") + ".mdtlbl";
      void this.openInNewFile(name, result.output);
      window.toast("反编译完成", 3000);
    } catch (e) {
      loader?.destroy?.();
      acode.alert("反编译出错", String((e as Error).message));
    }
  }

  /** 格式化 mlog（模式 i，原地替换） */
  private async actionFormat(): Promise<void> {
    const active = this.getActiveFile();
    if (!active || !/\.(mlog|logic)$/i.test(active.filename)) {
      window.toast("格式化仅支持 .mlog / .logic 文件", 3000);
      return;
    }
    try {
      const formatted = await compile(active.content, "i");
      active.file.session?.setValue?.(formatted);
      active.file.isUnsaved = true;
      window.toast("格式化完成", 3000);
    } catch (e) {
      acode.alert("格式化失败", String((e as Error).message).slice(0, 2000));
    }
  }

  /** lint 检查当前 Bang 文件 */
  private async actionLint(): Promise<void> {
    const active = this.getActiveFile();
    if (!active) return;
    try {
      const report = await lint(active.content);
      if (report.trim()) {
        acode.alert("Lint 报告", report.slice(0, 2000));
      } else {
        window.toast("Lint 通过，无提示", 3000);
      }
    } catch (e) {
      acode.alert("Lint 失败", String((e as Error).message).slice(0, 2000));
    }
  }

  /** 导入当前 mlog 中嵌入的源码 */
  private async actionImportSource(): Promise<void> {
    const active = this.getActiveFile();
    if (!active) return;
    const src = await extractSource(active.content);
    if (src === null) {
      window.toast("未找到嵌入源码（>DATA:）", 3000);
      return;
    }
    void this.openInNewFile(`restored-${Date.now()}.mdtlbl`, src);
    window.toast(`源码还原成功（${src.split("\n").length} 行）`, 3000);
  }

  /** 从剪贴板导入（支持完整 mlog 或纯嵌入串） */
  private async actionImportClipboard(): Promise<void> {
    const text = String(await this.readClipboard()).trim();
    if (!text) {
      window.toast("剪贴板为空", 3000);
      return;
    }
    let src = await extractSource(text);
    if (src === null && !text.includes("\n")) {
      try {
        src = await unpackSource(text);
      } catch {
        src = null;
      }
    }
    if (src === null) {
      window.toast("剪贴板内容无法解析出 Bang 源码", 3000);
      return;
    }
    void this.openInNewFile(`imported-${Date.now()}.mdtlbl`, src);
    window.toast(`源码导入成功（${src.split("\n").length} 行）`, 3000);
  }

  private actionToggleEmbed(): void {
    const next = this.embedEnabled() ? "off" : "on";
    localStorage.setItem(EMBED_KEY, next);
    window.toast(`mlog 源码嵌入已${next === "on" ? "开启" : "关闭"}`, 3000);
  }

  /** 自检：一次性报告各关键能力状态，便于定位问题 */
  private async actionDiagnose(): Promise<void> {
    const lines: string[] = [];
    lines.push(`插件版本: ${plugin.version}`);
    lines.push(`baseUrl: ${this.baseUrl}`);

    try {
      const el = acode.require("editorLanguages") as any;
      lines.push(`editorLanguages: ${el?.register ? "可用" : "缺失"}`);
      if (el?.getForPath) {
        const m = el.getForPath("probe.mdtlbl");
        lines.push(`模式解析(.mdtlbl): ${m?.name ?? "未匹配"}`);
      }
    } catch (e) {
      lines.push(`editorLanguages: 异常 ${(e as Error).message}`);
    }

    try {
      const sb = acode.require("sideButton") as any;
      lines.push(`sideButton: ${typeof sb === "function" ? "可用" : "缺失"}`);
    } catch (e) {
      lines.push(`sideButton: 异常 ${(e as Error).message}`);
    }

    try {
      const v = await compilerVersion();
      lines.push(`WASM 编译器: 就绪 v${v}`);
    } catch (e) {
      lines.push(`WASM 编译器: 失败 ${(e as Error).message}`);
    }

    try {
      const fs = acode.require("fs") as any;
      lines.push(`fs API: ${typeof fs === "function" ? "可用" : "缺失"}`);
    } catch (e) {
      lines.push(`fs API: 异常 ${(e as Error).message}`);
    }

    const active = this.getActiveFile();
    lines.push(`当前文件: ${active?.filename || "无"}`);
    lines.push(`当前文件类型: ${this.activeKind() ?? "非 Bang/mlog"}`);

    acode.alert("Bang 插件自检", lines.join("\n"));
  }

  // ---------- 保存诊断 + 自动保存 .logic ----------

  private onSaveDebounced(): void {
    if (this.lintTimer) clearTimeout(this.lintTimer);
    this.lintTimer = setTimeout(() => void this.onSaved(), 800);
  }

  private async onSaved(): Promise<void> {
    const active = this.getActiveFile();
    if (!active?.filename || !/\.(mdtlbl|mdtl)$/i.test(active.filename)) return;
    try {
      const result = await tryCompile(active.content, "c");
      if (!result.ok) {
        const firstLine = result.error.split("\n")[0];
        window.toast(`Bang 编译错误：${firstLine.slice(0, 80)}`, 4000);
        return;
      }
      const n = result.output.trimEnd().split("\n").length;
      // 与 VSCode 插件一致：保存后自动写 .logic
      if (active.file.uri || active.file.location) {
        const output = await this.buildOutput(result.output, active.content);
        const name = active.filename.replace(/\.(mdtlbl|mdtl)$/i, "") + ".logic";
        await this.saveNextTo(active, name, output);
        window.toast(`Bang 编译通过（${n} 行），已更新 ${name}`, 3000);
      } else {
        window.toast(`Bang 编译通过（${n} 行）`, 2000);
      }
    } catch {
      /* 静默诊断失败不打扰用户 */
    }
  }

  // ---------- 工具 ----------

  private async saveNextTo(
    active: { file: any; filename: string },
    name: string,
    content: string,
  ): Promise<string | null> {
    try {
      const fs = acode.require("fs") as any;
      const url: string = active.file.uri || active.file.location || "";
      if (!url) return null;
      const dir = url.slice(0, url.lastIndexOf("/") + 1);
      const filesystem = await fs(dir);
      const created = await filesystem.createFile(name, content);
      return typeof created === "string" ? created : null;
    } catch (e) {
      console.warn("[bang] save failed", e);
      window.toast("写入文件失败（文件可能未保存到磁盘）", 3000);
      return null;
    }
  }

  /** 打开输出：优先写到源文件同目录，否则写到插件缓存目录 */
  private async openInNewFile(name: string, content: string): Promise<void> {
    const editorManager = acode.require("editorManager") as any;
    try {
      const active = this.getActiveFile();
      let url: string | null = null;
      if (active?.file?.uri || active?.file?.location) {
        url = await this.saveNextTo(active, name, content);
      }
      if (!url) {
        const fs = acode.require("fs") as any;
        const cacheUrl = this.cacheFileUrl || "";
        const dir = cacheUrl.slice(0, cacheUrl.lastIndexOf("/") + 1);
        if (dir) {
          const filesystem = await fs(dir);
          url = await filesystem.createFile(name, content);
        }
      }
      if (url && typeof editorManager?.openFile === "function") {
        await editorManager.openFile(url);
        return;
      }
    } catch (e) {
      console.warn("[bang] openFile failed", e);
    }
    // 兜底：至少把内容给到剪贴板
    await this.copyToClipboard(content);
    window.toast("已复制到剪贴板（无法创建文件）", 3000);
  }

  private async copyToClipboard(text: string): Promise<void> {
    // Acode 没有 clipboard 模块，真机走 cordova 插件
    try {
      const cordova = (window as any).cordova;
      if (cordova?.plugins?.clipboard?.copy) {
        cordova.plugins.clipboard.copy(text);
        return;
      }
    } catch {
      /* fallthrough */
    }
    try {
      const clipboard = acode.require("clipboard") as any;
      if (clipboard?.writeText) {
        await clipboard.writeText(text);
        return;
      }
    } catch {
      /* fallthrough */
    }
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  private async readClipboard(): Promise<string> {
    const cordova = (window as any).cordova;
    if (cordova?.plugins?.clipboard?.paste) {
      const text = await new Promise<string>((resolve) => {
        try {
          cordova.plugins.clipboard.paste(
            (t: string) => resolve(t ?? ""),
            () => resolve(""),
          );
        } catch {
          resolve("");
        }
      });
      if (text) return text;
    }
    try {
      const clipboard = acode.require("clipboard") as any;
      if (clipboard?.readText) return await clipboard.readText();
      if (clipboard?.paste) return clipboard.paste() ?? "";
    } catch {
      /* fallthrough */
    }
    return await navigator.clipboard?.readText?.().catch(() => "") ?? "";
  }
}

if (window.acode) {
  const acodePlugin = new AcodePlugin();

  acode.setPluginInit(
    plugin.id,
    async (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
      acodePlugin.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      await acodePlugin.init($page, cacheFile, cacheFileUrl);
    },
  );

  acode.setPluginUnmount(plugin.id, () => {
    void acodePlugin.destroy();
  });
}
