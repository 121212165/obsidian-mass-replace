# Mass Replace

Vault-wide find and replace for Obsidian, with the safety rails the core
search-and-replace lacks.

## Features

- **Plain text or regex** search across the whole vault (configurable file
  extensions, default `md`), with optional case sensitivity
- **Preview before applying** — every file shows its match count and up to
  three matching lines with line numbers
- **Selective apply** — matches are pre-checked; uncheck any file to skip it
- **Automatic `.bak` backups** — each modified file gets a timestamped backup
  next to the original (toggleable)
- **One-click undo** — the last run is kept in memory and can be reversed
  exactly (backups stay on disk as a second safety net)
- Scope filter by path prefix (e.g. run it on one folder only)

## Usage

1. Ribbon `replace` icon or command "打开全库替换".
2. Enter find/replace (toggle 正则模式 for regex, `$1` capture groups work).
3. ① 扫描预览 → uncheck files you don't want touched.
4. ② 应用到勾选文件.

Undo works within the session via command "撤销上一轮替换".

## Notes

- Plain JavaScript, no build step; runs entirely offline.
