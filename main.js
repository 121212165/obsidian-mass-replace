/* Mass Replace —— 全库批量查找替换
 * 流程：输入查找/替换（支持正则）+ 范围过滤 → 预览每个文件的命中数与上下文 →
 * 勾选要改的文件 → 应用（可选 .bak 备份）→ 记录本轮操作，支持一键撤销（反向替换）。
 */
const { Plugin, Modal, Notice, PluginSettingTab, Setting, TFile } = require("obsidian");

const DEFAULT_SETTINGS = {
  backup: true,      // 应用前写 .bak
  includeExt: "md",  // 参与替换的扩展名（逗号分隔）
};

module.exports = class MassReplace extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved.settings || saved);
    // 撤销历史持久化（最近 5 轮；含替换前后全文，跨会话可撤销）
    this.history = saved.history || [];
    this.lastRun = null;

    this.addRibbonIcon("replace", "Mass Replace 全库替换", () => new ReplaceModal(this).open());
    this.addCommand({ id: "open", name: "打开全库替换", callback: () => new ReplaceModal(this).open() });
    this.addCommand({ id: "undo", name: "撤销上一轮替换", callback: () => this.undo() });
    this.addSettingTab(new MRSettingTab(this.app, this));
  }
  async saveSettings() { await this.saveData(this.settings); }

  async saveState() {
    await this.saveData({ settings: this.settings, history: this.history });
  }

  extList() { return this.settings.includeExt.split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean); }

  /** 构建查找正则；plain 模式转义 */
  buildRegex(find, isRegex, caseSensitive) {
    const pattern = isRegex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(pattern, caseSensitive ? "g" : "gi");
  }

  /** 扫描：返回 [{file, count, lines:[{n, text}]}]，限制每文件最多 3 条上下文 */
  async scan(re, exts) {
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (exts && !exts.includes(f.extension)) continue;
      const text = await this.app.vault.cachedRead(f);
      const lines = [];
      let count = 0;
      const ls = text.split("\n");
      for (let i = 0; i < ls.length; i++) {
        const m = ls[i].match(re);
        if (m) {
          count += m.length;
          if (lines.length < 3) lines.push({ n: i + 1, text: ls[i].slice(0, 160) });
        }
      }
      if (count) out.push({ file: f, count, lines });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  /** 应用替换到选定文件；返回变更记录用于撤销 */
  async apply(re, replacement, files) {
    const changes = [];
    for (const f of files) {
      const text = await this.app.vault.read(f);
      const m = text.match(re);
      if (!m) continue;
      if (this.settings.backup) {
        await this.app.vault.create(f.path + "." + Date.now() + ".bak", text);
      }
      const newText = await this.app.vault.process(f, (t) => t.replace(re, replacement));
      changes.push({ path: f.path, from: text, to: newText, count: m.length });
    }
    this.lastRun = { changes };
    if (changes.length) {
      this.history.unshift({ at: new Date().toISOString(), changes });
      this.history = this.history.slice(0, 5); // 只留最近 5 轮
      await this.saveState();
    }
    new Notice(`已替换 ${changes.length} 个文件（.bak 备份已${this.settings.backup ? "写入原目录" : "关闭"}）`);
    return changes;
  }

  /** 撤销：把 from 写回（.bak 不删，双保险） */
  async undo() {
    const round = this.lastRun || this.history[0];
    if (!round || !round.changes.length) {
      new Notice("没有可撤销的替换记录");
      return;
    }
    let n = 0;
    for (const c of round.changes) {
      const f = this.app.vault.getAbstractFileByPath(c.path);
      if (f instanceof TFile) {
        await this.app.vault.process(f, () => c.from);
        n++;
      }
    }
    this.lastRun = null;
    this.history = this.history.filter((h) => h !== round);
    await this.saveState();
    new Notice(`已撤销 ${n} 个文件（${round.at.slice(0, 16).replace("T", " ")} 那轮）`);
  }

  /** 简易 glob 过滤：* 任意段、? 单字符（对文件路径匹配） */
  globMatch(pattern, path) {
    const esc = pattern.split("").map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }).join("");
    return new RegExp("^" + esc + "$").test(path);
  }
};

class ReplaceModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "🔀 Mass Replace 全库替换" });

    const row = (label) => {
      const r = contentEl.createDiv();
      r.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:6px;";
      r.createEl("label", { text: label, attr: { style: "width:56px; font-size:12px; font-weight:600;" } });
      return r;
    };
    const findRow = row("查找");
    const find = findRow.createEl("input", { type: "text", placeholder: "文本或正则" });
    find.style.flex = "1";
    const optRow = contentEl.createDiv();
    optRow.style.cssText = "display:flex; gap:14px; margin-bottom:6px; font-size:12px;";
    const mkToggle = (parent, label, val) => {
      const l = parent.createEl("label");
      l.style.cssText = "display:flex; align-items:center; gap:4px; cursor:pointer;";
      const cb = l.createEl("input", { type: "checkbox" });
      cb.checked = val;
      l.createEl("span", { text: label });
      return cb;
    };
    const isRegex = mkToggle(optRow, "正则模式", false);
    const caseSensitive = mkToggle(optRow, "区分大小写", false);
    const replRow = row("替换为");
    const repl = replRow.createEl("input", { type: "text", placeholder: "留空=删除匹配（正则可用 $1 组）" });
    repl.style.flex = "1";
    const scopeRow = row("范围过滤");
    const scope = scopeRow.createEl("input", { type: "text", placeholder: "路径前缀或 glob（日记/*、*.md），逗号分隔，留空=全库" });
    scope.style.flex = "1";

    const scanBtn = contentEl.createEl("button", { text: "① 扫描预览", cls: "mod-cta" });
    scanBtn.style.width = "100%";
    const resultEl = contentEl.createDiv();
    resultEl.style.cssText = "margin-top:8px; max-height:45vh; overflow-y:auto;";
    let scanned = null;

    scanBtn.onclick = async () => {
      resultEl.empty();
      if (!find.value) {
        resultEl.createEl("div", { text: "请输入查找内容。", attr: { style: "color:var(--text-error); font-size:12px;" } });
        return;
      }
      let re;
      try {
        re = this.plugin.buildRegex(find.value, isRegex.checked, caseSensitive.checked);
      } catch (e) {
        resultEl.createEl("div", { text: "正则无效：" + e.message, attr: { style: "color:var(--text-error); font-size:12px;" } });
        return;
      }
      const scopes = scope.value.split(",").map((s) => s.trim()).filter(Boolean);
      const exts = this.plugin.extList();
      scanBtn.disabled = true; scanBtn.setText("扫描中…");
      const all = await this.plugin.scan(re, exts);
      scanned = scopes.length
        ? all.filter((x) => scopes.some((p) => p.includes("*") || p.includes("?") ? this.plugin.globMatch(p, x.file.path) : x.file.path.startsWith(p)))
        : all;
      scanBtn.disabled = false; scanBtn.setText("① 扫描预览");

      resultEl.createEl("div", {
        text: scanned.length ? `命中 ${scanned.length} 个文件 / ${scanned.reduce((s, x) => s + x.count, 0)} 处（已全选，取消勾选可跳过）` : "无命中。",
        attr: { style: "font-size:12px; font-weight:600; margin-bottom:4px;" },
      });
      this.checkboxes = [];
      for (const hit of scanned) {
        const item = resultEl.createDiv();
        item.style.cssText = "padding:4px 6px; margin-bottom:3px; border:1px solid var(--background-modifier-border); border-radius:6px; font-size:12px;";
        const line1 = item.createDiv();
        line1.style.cssText = "display:flex; align-items:center; gap:6px;";
        const cb = line1.createEl("input", { type: "checkbox" });
        cb.checked = true;
        this.checkboxes.push({ cb, hit });
        line1.createEl("span", { text: `${hit.file.path}`, attr: { style: "flex:1; font-weight:600;" } });
        line1.createEl("span", { text: hit.count + " 处", attr: { style: "color:var(--interactive-accent);" } });
        for (const l of hit.lines) {
          item.createEl("div", {
            text: `L${l.n}: ${l.text}`,
            attr: { style: "color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" },
          });
        }
      }
    };

    contentEl.createEl("button", {
      text: "② 应用到勾选文件（.bak 备份：" + (this.plugin.settings.backup ? "开" : "关") + "）",
      cls: "mod-cta",
    }).onclick = async () => {
      if (!scanned || !this.checkboxes) {
        new Notice("请先扫描预览");
        return;
      }
      const chosen = this.checkboxes.filter((x) => x.cb.checked).map((x) => x.hit.file);
      if (!chosen.length) {
        new Notice("未勾选任何文件");
        return;
      }
      let re;
      try {
        re = this.plugin.buildRegex(find.value, isRegex.checked, caseSensitive.checked);
      } catch (e) {
        new Notice("正则无效：" + e.message);
        return;
      }
      await this.plugin.apply(re, repl.value, chosen);
      this.close();
    };
  }
}

class MRSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("应用前写 .bak 备份")
      .setDesc("每份被修改的文件在同一目录写一份 时间戳.bak（推荐开启）").addToggle((t) =>
      t.setValue(this.plugin.settings.backup).onChange(async (v) => {
        this.plugin.settings.backup = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("参与替换的扩展名")
      .setDesc("逗号分隔，默认仅 md")
      .addText((t) => t.setValue(this.plugin.settings.includeExt).onChange(async (v) => {
        this.plugin.settings.includeExt = v || "md"; await this.plugin.saveSettings();
      }));
  }
}
