# Perplexity Memory History Library Exporter

Memory-focused fork of the original Perplexity exporter. This tool exports a Perplexity.ai Library, cleans the raw conversation data, and generates Markdown memory files that can be reused as context for other AI assistants, RAG workflows, local LLMs, or personal knowledge bases.

Original project:

- https://github.com/kylebrodeur/perplexity-exporter

This fork:

- https://github.com/Egomaniac95/perplexity-memory-history-library-exporter

> Status: working as of May 2026. Perplexity may change its Library structure or internal endpoints at any time. If the exporter stops detecting threads, the most likely file to update is `src/browser/scroller.ts`.

---

## What this fork does

The original project focused mainly on exporting Perplexity threads to JSON.

This fork changes the goal: it creates a cleaner memory-oriented export that is easier to feed into another AI system.

It can:

- export all detected Perplexity Library threads;
- export only new threads after a previous export;
- clean raw thread data;
- generate a consolidated Markdown memory file;
- split memory into Markdown chunks;
- preserve an export state for future incremental updates;
- avoid generating unnecessary JSON/JSONL/individual chat files by default;
- optionally keep raw files for backup/debugging;
- optionally filter low-value/noisy conversations;
- detect the end of the Library scroll more safely.

---

## Main improvements

Compared with the original exporter, this version adds:

- **Memory-first output**
  - `perplexity-memory.md`
  - `memory_chunks/`

- **Incremental update mode**
  - Uses exported thread IDs to avoid re-downloading old conversations.
  - Stops scrolling once already-known threads are reached.

- **Cleaner final folder**
  - Keeps only the memory output and technical state files by default.
  - Avoids large intermediate JSON/JSONL files unless explicitly requested.

- **Export state tracking**
  - `perplexity-export-state.json`
  - `last-thread-id.txt`

- **Improved scrolling behavior**
  - Handles Perplexity Library infinite scroll.
  - Includes recovery logic.
  - Stops after repeated failed recovery cycles when the Library bottom is confirmed.

- **Noise reduction options**
  - Can omit sources.
  - Can filter short or low-value searches.

---

## Important limitation

This project depends on Perplexity's web UI and internal, unofficial endpoints.

It may break if Perplexity changes:

- the Library DOM structure;
- thread link selectors;
- infinite scroll behavior;
- network response structure;
- internal API response format;
- `/rest/thread/<id>` behavior.

Files most likely to require maintenance if Perplexity changes its structure:

```text
src/browser/scroller.ts
src/perplexity/library.ts
src/perplexity/api.ts
```

---

## Requirements

- Node.js 18+
- pnpm
- Git
- A Perplexity.ai account
- Chromium installed through Playwright

---

## Installation

```bash
git clone https://github.com/Egomaniac95/perplexity-memory-history-library-exporter.git
cd perplexity-memory-history-library-exporter

pnpm install
npx playwright install chromium
pnpm build
```

---

## Usage

```bash
node dist/index.js
```

The browser will open.

1. Log in to Perplexity.ai if needed.
2. Make sure the Library is accessible.
3. Return to the terminal.
4. Press Enter.
5. Choose the export mode.

The app will ask whether to:

```text
1) Export everything
2) Export only updates
```

---

## Full export mode

Use this mode for:

- first export;
- exporting a new Perplexity account;
- rebuilding the complete memory archive;
- creating a full backup.

The app will:

1. open the Perplexity Library;
2. scroll until all detectable threads are accumulated;
3. fetch full thread data;
4. clean the raw content;
5. generate Markdown memory output;
6. write state files for future incremental updates.

---

## Incremental update mode

Use this mode after a previous export already exists.

When asked for the previous export path, provide either the previous export folder:

```text
D:\path\to\perplexity-export-XXXXXXXXXXXXX
```

or directly the state file:

```text
D:\path\to\perplexity-export-state.json
```

The exporter will:

1. load already-exported thread IDs;
2. scroll the Library until it reaches known threads;
3. download only new threads;
4. merge state information;
5. generate updated memory output.

This avoids repeating long exports that may take several hours.

---

## Default output

The default final output is:

```text
perplexity-export-XXXXXXXXXXXXX/
  perplexity-memory.md
  memory_chunks/
    memory_001.md
    memory_002.md
    memory_003.md
  perplexity-export-state.json
  last-thread-id.txt
```

### Output files

| File or folder | Purpose |
|---|---|
| `perplexity-memory.md` | Consolidated Markdown memory file. |
| `memory_chunks/` | Split Markdown chunks for importing into other tools or AI assistants. |
| `perplexity-export-state.json` | Technical state file containing exported thread IDs for future incremental updates. |
| `last-thread-id.txt` | Quick reference for the latest exported thread ID. |

---

## Environment variables

### Keep raw files

By default, this fork tries to keep the final output clean. To keep raw intermediate files:

PowerShell:

```powershell
$env:PEX_KEEP_RAW="1"
node .\dist\index.js
```

Bash:

```bash
PEX_KEEP_RAW=1 node dist/index.js
```

---

### Enable noise filter

PowerShell:

```powershell
$env:PEX_FILTER_NOISE="1"
node .\dist\index.js
```

Bash:

```bash
PEX_FILTER_NOISE=1 node dist/index.js
```

For a master archive, keeping the noise filter disabled is recommended. The noise filter is useful only when a smaller secondary memory export is preferred.

---

## Cleaning an existing export

If a previous run already produced `perplexity-threads.json`, the cleaner can regenerate memory files without repeating the browser export:

```powershell
node .\tools\clean-perplexity-export.cjs `
  .\perplexity-export-XXXXXXXXXXXXX\perplexity-threads.json `
  --out .\perplexity-export-XXXXXXXXXXXXX\clean_export `
  --chunks-only `
  --no-sources `
  --delete-out-dir-first
```

Useful options:

```text
--chunks-only
--no-sources
--filter-noise
--delete-out-dir-first
```

---

## Scroller end detection

The Library scroller includes recovery logic for cases where Perplexity does not immediately load older threads.

The exporter stops scrolling when repeated recovery cycles produce:

- no new accumulated threads;
- no new network threads;
- no scroll-height growth;
- bottom gap equal to zero.

This prevents loops such as:

```text
Recovery 78/1000
```

when the real end of the Library has already been reached.

---

## Privacy warning

Do not commit generated exports or browser session data.

Generated data may contain:

- private conversations;
- thread IDs;
- URLs;
- citations/sources;
- cookies or authenticated browser state;
- personal information.

The `.gitignore` is configured to exclude browser profiles, raw exports, memory files, JSON/JSONL outputs, and temporary folders.

Before publishing changes, check for sensitive files:

```powershell
git ls-files | Select-String 'git-private-history|browser-data|perplexity-export-|perplexity-update-|memory_chunks|perplexity-threads\.json|perplexity-memory\.md|\.jsonl$'
```

The command should return nothing.

---

## Project structure

```text
src/
  browser/
    context.ts
    scroller.ts
    status-badge.ts
    console-overlay.ts
  cli/
    output.ts
    prompt.ts
  perplexity/
    api.ts
    auth.ts
    export.ts
    library.ts
  utils/
    paths.ts
  exporter.ts
  index.ts
  types.ts

tools/
  clean-perplexity-export.cjs
  run-export-and-clean.cjs
```

---

## Suggested GitHub repository description

```text
Memory-focused Perplexity Library exporter with Markdown chunks, cleaning pipeline and incremental updates.
```

---

## Credits

Based on the original project:

- https://github.com/kylebrodeur/perplexity-exporter

This fork modifies the export flow, cleaning pipeline, memory generation, chunking behavior, incremental update logic, and scroll-end detection.

---

## License

MIT.
