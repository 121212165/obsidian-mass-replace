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

    this.addRibbonIcon("replace", "Mass Replace — vault-wide replace", () => new ReplaceModal(this).open());
    this.addCommand({ id: "open", name: "Open vault-wide replace", callback: () => new ReplaceModal(this).open() });
    this.addCommand({ id: "undo", name: "Undo the last replace", callback: () => this.undo() });
    this.addCommand({ id: "undo-pick", name: "Undo a specific round…", callback: () => new UndoPickModal(this).open() });
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
    new Notice(`Replaced ${changes.length} file(s) (.bak backup ${this.settings.backup ? "written" : "off"})`);
    return changes;
  }

  /** 撤销指定轮次：把 from 写回（.bak 不删，双保险）；轮次从 history 移除 */
  async undoRound(round) {
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
    new Notice(`Restored ${n} file(s) (round at ${round.at.slice(0, 16).replace("T", " ")})`);
  }

  /** 撤销：把 from 写回（.bak 不删，双保险） */
  async undo() {
    const round = this.lastRun || this.history[0];
    if (!round || !round.changes.length) {
      new Notice("Nothing to undo");
      return;
    }
    await this.undoRound(round);
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

  /** dry-run 预览报告（markdown）：每文件命中数 + 行摘录 */
  buildReport(find, replacement, scanned) {
    const lines = [
      "# Mass Replace Preview Report " + new Date().toISOString().slice(0, 16).replace("T", " "),
      "",
      `- Find: \`${find}\``,
      `- Replace with: \`${replacement || "(delete matches)"}\``,
      `- Matches: ${scanned.length} file(s) / ${scanned.reduce((s, x) => s + x.count, 0)} match(es)`,
      "",
      "| File | Matches | First line |",
      "|---|---|---|",
    ];
    for (const x of scanned) {
      const first = x.lines.length ? `L${x.lines[0].n}` : "";
      lines.push(`| \`${x.file.path}\` | ${x.count} | ${first} |`);
    }
    return lines.join("\n");
  }
};

class UndoPickModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "⏪ Undo a specific round" });
    const rounds = this.plugin.history || [];
    if (!rounds.length) {
      contentEl.createEl("div", { text: "No replace history yet.", attr: { style: "color:var(--text-muted); font-size:12px;" } });
      return;
    }
    contentEl.createEl("div", { text: "Restoring writes back the full pre-replace content of every file in the round; the round is then removed from history.", attr: { style: "color:var(--text-muted); font-size:11px; margin-bottom:6px;" } });
    for (const r of rounds) {
      const nFiles = r.changes.length;
      const nHits = r.changes.reduce((s, c) => s + (c.count || 0), 0);
      const item = contentEl.createDiv();
      item.style.cssText = "display:flex; align-items:center; gap:8px; padding:4px 6px; margin-bottom:3px; border:1px solid var(--background-modifier-border); border-radius:6px; font-size:12px;";
      const lbl = item.createDiv();
      lbl.style.cssText = "flex:1;";
      lbl.createEl("div", { text: r.at.slice(0, 16).replace("T", " "), attr: { style: "font-weight:600;" } });
      lbl.createEl("div", { text: `${nFiles} file(s) / ${nHits} match(es) · ${r.changes[0].path}${nFiles > 1 ? ` +${nFiles - 1} more` : ""}`, attr: { style: "color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" } });
      item.createEl("button", { text: "Undo this round" }).onclick = async (ev) => {
        ev.currentTarget.disabled = true; ev.currentTarget.setText("Undoing…");
        await this.plugin.undoRound(r);
        this.close();
      };
    }
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmWikilinkModal extends Modal {
  constructor(app, onConfirm) { super(app); this.onConfirm = onConfirm; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "⚠️ Wikilink matches — confirm" });
    contentEl.createEl("div", {
      text: "This round touches lines containing [[wikilink]]. A bad replace can corrupt cross-note links.\nTo proceed, verify each path in the main preview, then retry.",
      attr: { style: "white-space:pre-line; font-size:13px; margin-bottom:10px;" },
    });
    const row = contentEl.createDiv();
    row.style.cssText = "display:flex; gap:8px;";
    const back = row.createEl("button", { text: "Back" });
    back.onclick = () => this.close();
    const go = row.createEl("button", { text: "I've verified — apply anyway", cls: "mod-cta" });
    go.onclick = () => { this.close(); this.onConfirm(); };
  }
  onClose() { this.contentEl.empty(); }
}

class ReplaceModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "🔀 Mass Replace — vault-wide replace" });

    const row = (label) => {
      const r = contentEl.createDiv();
      r.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:6px;";
      r.createEl("label", { text: label, attr: { style: "width:56px; font-size:12px; font-weight:600;" } });
      return r;
    };
    const findRow = row("Find");
    const find = findRow.createEl("input", { type: "text", placeholder: "text or /regex/" });
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
    const isRegex = mkToggle(optRow, "regex mode", false);
    const caseSensitive = mkToggle(optRow, "case sensitive", false);
    const replRow = row("Replace with");
    const repl = replRow.createEl("input", { type: "text", placeholder: "empty = delete matches; regex $1 groups work" });
    repl.style.flex = "1";
    const scopeRow = row("Scope filter");
    const scope = scopeRow.createEl("input", { type: "text", placeholder: "path prefix or glob, comma separated, empty = whole vault" });
    scope.style.flex = "1";

    const scanBtn = contentEl.createEl("button", { text: "① Scan & preview", cls: "mod-cta" });
    scanBtn.style.width = "100%";
    const resultEl = contentEl.createDiv();
    resultEl.style.cssText = "margin-top:8px; max-height:45vh; overflow-y:auto;";
    let scanned = null;

    scanBtn.onclick = async () => {
      resultEl.empty();
      if (!find.value) {
        resultEl.createEl("div", { text: "Enter something to find.", attr: { style: "color:var(--text-error); font-size:12px;" } });
        return;
      }
      let re;
      try {
        re = this.plugin.buildRegex(find.value, isRegex.checked, caseSensitive.checked);
      } catch (e) {
        resultEl.createEl("div", { text: "Invalid regex: " + e.message, attr: { style: "color:var(--text-error); font-size:12px;" } });
        return;
      }
      const scopes = scope.value.split(",").map((s) => s.trim()).filter(Boolean);
      const exts = this.plugin.extList();
      scanBtn.disabled = true; scanBtn.setText("Scanning…");
      const all = await this.plugin.scan(re, exts);
      scanned = scopes.length
        ? all.filter((x) => scopes.some((p) => p.includes("*") || p.includes("?") ? this.plugin.globMatch(p, x.file.path) : x.file.path.startsWith(p)))
        : all;
      scanBtn.disabled = false; scanBtn.setText("① Scan & preview");

      resultEl.createEl("div", {
        text: scanned.length ? `${scanned.length} file(s) / ${scanned.reduce((s, x) => s + x.count, 0)} matches — all pre-checked, uncheck files to skip` : "No matches.",
        attr: { style: "font-size:12px; font-weight:600; margin-bottom:4px;" },
      });
      // wikilink 命中预警：误替换会污染全链引用，需显式确认才允许应用（issue#1）
      this.wikilinkRisk = scanned.some((x) => x.lines.some((l) => l.text.includes("[[")));
      if (this.wikilinkRisk) {
        resultEl.createEl("div", {
          text: "⚠️ Matches touch [[wikilink]] — a bad replace can corrupt cross-note links. Verify each path before applying.",
          attr: { style: "color:var(--text-warning, #e6b450); font-size:12px; font-weight:600; margin-bottom:4px;" },
        });
      }
      const repBtn = resultEl.createEl("button", { text: "Copy dry-run report", attr: { style: "font-size:11px; margin-bottom:6px;" } });
      repBtn.onclick = () => {
        navigator.clipboard.writeText(this.plugin.buildReport(find.value, repl.value, scanned));
        new Notice("Preview report copied to clipboard");
      };
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
        line1.createEl("span", { text: hit.count + " match(es)", attr: { style: "color:var(--interactive-accent);" } });
        for (const l of hit.lines) {
          item.createEl("div", {
            text: `L${l.n}: ${l.text}`,
            attr: { style: "color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" },
          });
        }
      }
    };

    const applyBtn = contentEl.createEl("button", {
      text: "② Apply to checked files (.bak backup: " + (this.plugin.settings.backup ? "on" : "off") + ")",
      cls: "mod-cta",
    });
    applyBtn.style.width = "100%";
    applyBtn.onclick = async () => {
      if (!scanned || !this.checkboxes) {
        new Notice("Scan first");
        return;
      }
      const chosen = this.checkboxes.filter((x) => x.cb.checked).map((x) => x.hit.file);
      if (!chosen.length) {
        new Notice("No files selected");
        return;
      }
      if (this.wikilinkRisk && !this.wikilinkConfirmed) {
        new ConfirmWikilinkModal(this.app, () => {
          this.wikilinkConfirmed = true;
          applyBtn.click();
        }).open();
        return;
      }
      let re;
      try {
        re = this.plugin.buildRegex(find.value, isRegex.checked, caseSensitive.checked);
      } catch (e) {
        new Notice("Invalid regex: " + e.message);
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
    new Setting(containerEl).setName("Write .bak backup before applying")
      .setDesc("Writes a timestamped .bak next to each modified file (recommended)").addToggle((t) =>
      t.setValue(this.plugin.settings.backup).onChange(async (v) => {
        this.plugin.settings.backup = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("File extensions to include")
      .setDesc("Comma separated, default md only")
      .addText((t) => t.setValue(this.plugin.settings.includeExt).onChange(async (v) => {
        this.plugin.settings.includeExt = v || "md"; await this.plugin.saveSettings();
      }));
  }
}
