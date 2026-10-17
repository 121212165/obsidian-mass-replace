# Mass Replace

Vault-wide find and replace for Obsidian, with the safety rails the core
search-and-replace lacks.

## Features

- **Plain text or regex** search across the whole vault (configurable file
  extensions, default `md`), with optional case sensitivity
- **Preview before applying** — every file shows its match count and up to
  three matching lines with line numbers
- **Wikilink guard** — if matches touch `[[wikilink]]` lines, a warning is
  raised and you must explicitly confirm before anything is written
- **Selective apply** — matches are pre-checked; uncheck any file to skip it
- **Automatic `.bak` backups** — each modified file gets a timestamped backup
  next to the original (toggleable)
- **Undo history** — the last 5 replace rounds are persisted and can be
  reversed exactly, *any round at a time* (command: "Undo a specific round…")
- **Dry-run report** — one click copies a per-file markdown preview report
- Scope filter by path prefix or glob (e.g. run it on one folder only)

## Usage

1. Ribbon `replace` icon or command "Open vault-wide replace".
2. Enter find/replace (toggle "regex mode" for regex; `$1` capture groups work).
3. ① Scan & preview → uncheck files you don't want touched.
4. ② Apply to checked files. Or "Copy dry-run report" to review first.

Undo within and across sessions via "Undo the last replace" or
"Undo a specific round…".

## Privacy

Runs 100% locally on your vault files. No network access.

## Support

- [Issues](https://github.com/121212165/obsidian-mass-replace/issues) — bug
  reports and feature requests are welcome.

## Notes

- Plain JavaScript, no build step; runs entirely offline.
