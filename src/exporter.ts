import type { BrowserContext } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { existsSync, rmSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createStatusBadge } from './browser/status-badge.js';
import { BrowserConsole } from './browser/console-overlay.js';
import { autoScrollToLoadAll } from './browser/scroller.js';
import { ensureLoggedIn, navigateToLibrary } from './perplexity/auth.js';
import { scrapeThreadLinks } from './perplexity/library.js';
import { exportThreads } from './perplexity/export.js';
import { printSummary } from './cli/output.js';
import { resolveSavePath } from './utils/paths.js';
import type { ThreadLink } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface ExistingExportState {
  ids: Set<string>;
  sourcePath: string;
  latestThreadId?: string;
  latestThreadTitle?: string;
}

type ExportMode = 'full' | 'update';

function removeIfExists(filePath: string): void {
  try {
    rmSync(filePath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function removeRawExportArtifacts(exportDir: string): void {
  for (const name of [
    'perplexity-threads.json',
    'perplexity-threads.jsonl',
    'perplexity-threads.raw.jsonl',
    'threads-index.json',
    'failed-or-empty-threads.jsonl',
    'summary.json',
    'clean_export',
    'md',
    'perplexity-clean.json',
    'perplexity-clean.jsonl',
    'index.tsv',
    'empty-or-failed-threads.jsonl',
    'excluded-by-noise-filter.jsonl',
  ]) {
    removeIfExists(path.join(exportDir, name));
  }
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function chooseExportMode(): Promise<ExportMode> {
  console.log('');
  console.log('\nSelect export mode:');
  console.log('  1) Export everything');
  console.log('  2) Export updates only');
  console.log('');

  const answer = (await ask('\nOption [1-2] (Enter = 1): ')).toLowerCase();
  if (answer === '2' || answer.includes('act') || answer.includes('upd')) return 'update';
  return 'full';
}

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;

  return Math.min(max, Math.max(min, value));
}

function normalizePathInput(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDir(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function extractThreadIdsFromText(text: string): Set<string> {
  const ids = new Set<string>();

  // Preferred: real Perplexity thread URLs.
  const searchUrlRe = /perplexity\.ai\/search\/[^\s)\]"'<>]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const match of text.matchAll(searchUrlRe)) {
    if (match[1] && UUID_RE.test(match[1])) ids.add(match[1].toLowerCase());
  }

  // Older memory files included explicit metadata lines like: - ID: <uuid>
  const idLineRe = /^\s*-\s*ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/gim;
  for (const match of text.matchAll(idLineRe)) {
    if (match[1] && UUID_RE.test(match[1])) ids.add(match[1].toLowerCase());
  }

  return ids;
}

function collectThreadIdsFromJsonValue(value: unknown, ids: Set<string>): void {
  if (!value) return;

  if (typeof value === 'string') {
    for (const id of extractThreadIdsFromText(value)) ids.add(id);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectThreadIdsFromJsonValue(item, ids);
    return;
  }

  if (typeof value !== 'object') return;

  const obj = value as Record<string, unknown>;

  const exportMeta = obj.__export;
  if (exportMeta && typeof exportMeta === 'object') {
    const exportId = (exportMeta as Record<string, unknown>).id;
    if (typeof exportId === 'string' && UUID_RE.test(exportId)) ids.add(exportId.toLowerCase());
  }

  const stateThreadIds = obj.thread_ids;
  if (Array.isArray(stateThreadIds)) {
    for (const id of stateThreadIds) {
      if (typeof id === 'string' && UUID_RE.test(id)) ids.add(id.toLowerCase());
    }
  }

  // Do not collect every generic nested `id`: raw Perplexity payloads contain
  // many UUIDs that are not thread IDs. Only accept explicit export metadata,
  // state thread_ids, or real /search/ URLs.
  for (const key of ['url', 'href', 'link', 'permalink', 'thread_url']) {
    const raw = obj[key];
    if (typeof raw === 'string') {
      for (const id of extractThreadIdsFromText(raw)) ids.add(id);
    }
  }

  // Continue walking so state files and nested exporter metadata are handled.
  for (const child of Object.values(obj)) collectThreadIdsFromJsonValue(child, ids);
}

function readJsonThreadIds(filePath: string): ExistingExportState {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  const ids = new Set<string>();

  if (!text) return { ids, sourcePath: filePath };

  try {
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      collectThreadIdsFromJsonValue(parsed, ids);
      return {
        ids,
        sourcePath: filePath,
        latestThreadId:
          typeof parsed?.latest_thread_id === 'string' ? parsed.latest_thread_id : undefined,
        latestThreadTitle:
          typeof parsed?.latest_thread_title === 'string' ? parsed.latest_thread_title : undefined,
      };
    }
  } catch {
    // Fall back to text extraction below.
  }

  // JSONL fallback.
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      collectThreadIdsFromJsonValue(JSON.parse(line), ids);
    } catch {
      for (const id of extractThreadIdsFromText(line)) ids.add(id);
    }
  }

  return { ids, sourcePath: filePath };
}

function readTextThreadIds(filePath: string): ExistingExportState {
  const text = readFileSync(filePath, 'utf8');
  const ids = extractThreadIdsFromText(text);
  return { ids, sourcePath: filePath };
}

function candidateFilesFromDirectory(dir: string): string[] {
  const candidates = [
    'perplexity-export-state.json',
    '.perplexity-export-state.json',
    'export-state.json',
    'perplexity-memory.md',
    path.join('clean_export', 'perplexity-export-state.json'),
    path.join('clean_export', '.perplexity-export-state.json'),
    path.join('clean_export', 'perplexity-memory.md'),
    'threads-index.json',
    'perplexity-threads.json',
    'perplexity-threads.jsonl',
  ].map((name) => path.join(dir, name));

  for (const chunksRel of ['memory_chunks', path.join('clean_export', 'memory_chunks')]) {
    const chunksDir = path.join(dir, chunksRel);
    if (!isDir(chunksDir)) continue;
    for (const name of readdirSync(chunksDir)) {
      if (/\.md$/i.test(name)) candidates.push(path.join(chunksDir, name));
    }
  }

  return candidates.filter(isFile);
}

function loadKnownThreadIds(inputPath: string): ExistingExportState {
  const resolved = path.resolve(normalizePathInput(inputPath));
  const files = isDir(resolved) ? candidateFilesFromDirectory(resolved) : [resolved];

  const merged: ExistingExportState = { ids: new Set<string>(), sourcePath: resolved };

  for (const file of files) {
    let state: ExistingExportState;
    if (/\.(json|jsonl)$/i.test(file)) state = readJsonThreadIds(file);
    else state = readTextThreadIds(file);

    for (const id of state.ids) merged.ids.add(id.toLowerCase());
    if (!merged.latestThreadId && state.latestThreadId) merged.latestThreadId = state.latestThreadId;
    if (!merged.latestThreadTitle && state.latestThreadTitle) merged.latestThreadTitle = state.latestThreadTitle;

    // A state file is authoritative; no need to parse huge raw JSON after it.
    if (/perplexity-export-state\.json$/i.test(file) && merged.ids.size > 0) {
      merged.sourcePath = file;
      break;
    }
  }

  return merged;
}

async function promptExistingExportState(): Promise<ExistingExportState> {
  console.log('');
  console.log('Paste the previous export path. It can be:');
  console.log('  - perplexity-export-... folder');
  console.log('  - perplexity-export-state.json');
  console.log('  - old perplexity-memory.md with IDs');
  console.log('  - perplexity-threads.json if you still have it');
  console.log('');

  while (true) {
    const raw = await ask('Previous export path: ');
    const normalized = normalizePathInput(raw);
    if (!normalized) {
      console.log('You must provide a path to use update mode.');
      continue;
    }

    if (!existsSync(path.resolve(normalized))) {
      console.log('That path does not exist. Check quotes/spaces or drag the folder/file into the terminal.');
      continue;
    }

    const state = loadKnownThreadIds(normalized);
    if (state.ids.size === 0) {
      console.log('Could not find thread IDs in that path. Try the original export folder or perplexity-threads.json.');
      continue;
    }

    return state;
  }
}

function writeExportState(
  exportDir: string,
  mode: ExportMode,
  previousState: ExistingExportState | null,
  detectedThreads: ThreadLink[],
  attemptedThreads: ThreadLink[],
  completedThreadIds: string[],
  failedThreadIds: string[]
): void {
  const known = new Set<string>();
  if (previousState) {
    for (const id of previousState.ids) known.add(id.toLowerCase());
  }
  for (const id of completedThreadIds) {
    if (UUID_RE.test(id)) known.add(id.toLowerCase());
  }

  const threadIds = [...known];
  const latestCompleted = completedThreadIds[0] || previousState?.latestThreadId || '';
  const latestThread = attemptedThreads.find((t) => t.id === latestCompleted);

  const state = {
    version: 1,
    generated_at: new Date().toISOString(),
    mode,
    previous_state_source: previousState?.sourcePath || '',
    latest_thread_id: latestCompleted,
    latest_thread_title: latestThread?.title || previousState?.latestThreadTitle || '',
    total_known_thread_ids: threadIds.length,
    newly_completed_thread_ids: completedThreadIds,
    failed_thread_ids: failedThreadIds,
    last_run: {
      export_dir: exportDir,
      detected_threads: detectedThreads.length,
      attempted_threads: attemptedThreads.length,
      completed_threads: completedThreadIds.length,
      failed_threads: failedThreadIds.length,
    },
    thread_ids: threadIds,
  };

  writeFileSync(path.join(exportDir, 'perplexity-export-state.json'), JSON.stringify(state, null, 2), 'utf8');
  writeFileSync(path.join(exportDir, 'last-thread-id.txt'), `${latestCompleted}\n`, 'utf8');
}

function runCleanerForMemoryChunks(exportDir: string, jsonPath: string): boolean {
  const cleanerPath = path.join(process.cwd(), 'tools', 'clean-perplexity-export.cjs');

  if (!existsSync(cleanerPath)) {
    console.warn('⚠️ Could not find tools\\clean-perplexity-export.cjs; the raw export will be kept.');
    return false;
  }

  // Remove stale final outputs before regenerating.
  removeIfExists(path.join(exportDir, 'memory_chunks'));
  removeIfExists(path.join(exportDir, 'perplexity-memory.md'));

  const args = [
    cleanerPath,
    jsonPath,
    '--out',
    exportDir,
    '--chunks-only',
    '--no-sources',
    '--state',
  ];

  if (process.env.PEX_FILTER_NOISE === '1') args.push('--filter-noise');
  if (process.env.MEMORY_CHUNK_SIZE) args.push('--chunk-size', process.env.MEMORY_CHUNK_SIZE);

  console.log('\n🧹 Generating clean memory chunks...');
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      CHUNKS_ONLY: '1',
      MAX_SOURCES: '0',
      KEEP_SOURCES: '0',
      WRITE_MD: '0',
      WRITE_SINGLE_MEMORY: '1',
      WRITE_CLEAN_JSON: '0',
      WRITE_STATE: '1',
    },
  });

  if (result.status !== 0) {
    console.warn(`⚠️ Cleaner exited with code ${result.status}; the raw export will be kept.`);
    return false;
  }

  return true;
}

export async function runExport(context: BrowserContext): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());

  console.log('📋 Steps:');
  console.log('   1. Browser opened');
  console.log('   2. Navigating to Perplexity Library...\n');

  await page.goto('https://www.perplexity.ai', { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn(page);

  const mode = await chooseExportMode();
  const previousState = mode === 'update' ? await promptExistingExportState() : null;

  if (previousState) {
    console.log('');
    console.log(`🧭 Update mode: ${previousState.ids.size} already-known threads.`);
    console.log(`📌 Source: ${previousState.sourcePath}`);
    if (previousState.latestThreadTitle || previousState.latestThreadId) {
      console.log(`🔖 Latest reference: ${previousState.latestThreadTitle || previousState.latestThreadId}`);
    }
  }

  await navigateToLibrary(page);
  await createStatusBadge(page);

  console.log('📜 Scrolling to load threads...');
  if (mode === 'update') {
    console.log('   💡 It will stop when it finds an already-exported thread.\n');
  } else {
    console.log('   💡 This may take a while for large libraries\n');
  }

  const scrollWaitMs = readEnvInt('PEX_SCROLL_WAIT_MS', mode === 'update' ? 450 : 500, 250, 2000);
  const stableThreshold = readEnvInt('PEX_SCROLL_STABLE_THRESHOLD', 8, 4, 30);
  const maxFailedRecoveryCycles = readEnvInt('PEX_MAX_FAILED_RECOVERY_CYCLES', 25, 8, 120);

  await autoScrollToLoadAll(page, {
    maxAttempts: 20000,
    stableThreshold,
    waitMs: scrollWaitMs,
    recoveryCycles: mode === 'update' ? 30 : 1000,
    maxFailedRecoveryCycles,
    minExpectedThreads: 0,
    stopAtThreadIds: previousState ? [...previousState.ids] : [],
    stopAfterKnownSeenAttempts: 2,
  });

  console.log('\n💉 Preparing export...\n');
  await page.waitForTimeout(1000);

  const detectedThreads = await scrapeThreadLinks(page);
  const knownIds = previousState?.ids ?? new Set<string>();
  const threads = mode === 'update'
    ? detectedThreads.filter((thread) => !knownIds.has(thread.id.toLowerCase()))
    : detectedThreads;

  const overlay = new BrowserConsole(page);
  await overlay.mount();

  await overlay.log(
    mode === 'update'
      ? `🧭 Update mode: ${detectedThreads.length} detected, ${threads.length} new`
      : `📦 Full mode: ${detectedThreads.length} detected`,
    '#00bfff'
  );

  if (mode === 'update' && threads.length === 0) {
    console.log('✅ No new threads to export.');
    await overlay.log('✅ No new threads to export.', '#00ff00');
    await page.waitForTimeout(5000);
    return;
  }

  const saveDir = 'current';
  const actualPath = resolveSavePath(saveDir);
  const exportDir = path.join(actualPath, `${mode === 'update' ? 'perplexity-update' : 'perplexity-export'}-${Date.now()}`);

  await fs.mkdir(exportDir, { recursive: true });

  const indexPath = path.join(exportDir, 'threads-index.json');
  const jsonPath = path.join(exportDir, 'perplexity-threads.json');
  const jsonlPath = path.join(exportDir, 'perplexity-threads.jsonl');
  const failedPath = path.join(exportDir, 'failed-or-empty-threads.jsonl');
  const summaryPath = path.join(exportDir, 'summary.json');

  await fs.writeFile(indexPath, JSON.stringify(threads, null, 2), 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log(mode === 'update' ? '💾 UPDATE EXPORT ENABLED' : '💾 FULL EXPORT ENABLED');
  console.log('='.repeat(60));
  console.log(`📁 Folder: ${exportDir}`);
  console.log(`🧭 Index:  ${indexPath}`);
  console.log(`📦 JSON:   ${jsonPath}`);
  console.log(`🧱 JSONL:  ${jsonlPath}`);
  console.log(`⚠️ Failed/empty log: ${failedPath}`);
  console.log('='.repeat(60) + '\n');

  await overlay.log(`💾 Export folder: ${exportDir}`, '#00bfff');
  await overlay.log(`🧱 Safe recovery file: ${jsonlPath}`, '#00bfff');

  console.log('⬇️ Exporting and saving selected threads immediately...\n');

  const startedAt = new Date().toISOString();

  const exportConcurrency = readEnvInt('PEX_EXPORT_CONCURRENCY', mode === 'update' ? 2 : 3, 1, 6);
  const exportDelayMs = readEnvInt('PEX_EXPORT_DELAY_MS', mode === 'update' ? 350 : 250, 0, 5000);
  const retryCount = readEnvInt('PEX_EXPORT_RETRY_COUNT', 4, 1, 8);
  const retryBaseDelayMs = readEnvInt('PEX_EXPORT_RETRY_BASE_DELAY_MS', 1800, 500, 10000);

  const result = await exportThreads(page, threads, overlay, {
    jsonPath,
    jsonlPath,
    failedPath,
    delayMs: exportDelayMs,
    retryCount,
    retryBaseDelayMs,
    concurrency: exportConcurrency,
  });

  const finishedAt = new Date().toISOString();

  const summary = {
    startedAt,
    finishedAt,
    mode,
    previousStateSource: previousState?.sourcePath || '',
    knownBeforeCount: previousState?.ids.size ?? 0,
    detectedThreads: detectedThreads.length,
    selectedForExport: threads.length,
    exportedCount: result.count ?? 0,
    successCount: result.successCount ?? 0,
    errorCount: result.errorCount ?? 0,
    exportDir,
    files: {
      indexPath,
      jsonPath,
      jsonlPath,
      failedPath,
      summaryPath,
    },
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  printSummary(result);

  const cleanedOk = runCleanerForMemoryChunks(exportDir, jsonPath);

  writeExportState(
    exportDir,
    mode,
    previousState,
    detectedThreads,
    threads,
    result.completedThreadIds ?? [],
    result.failedThreadIds ?? []
  );

  if (cleanedOk && process.env.PEX_KEEP_RAW !== '1') {
    removeRawExportArtifacts(exportDir);
  }

  await overlay.appendHtml(`
    ✅ Export completed!
    Location: ${exportDir}
  `);

  console.log('\n' + '='.repeat(60));
  console.log('✅ EXPORT COMPLETE!');
  console.log('='.repeat(60));
  console.log(`📁 Final result: ${exportDir}`);
  if (!cleanedOk || process.env.PEX_KEEP_RAW === '1') {
    console.log(`📥 Raw JSON: ${jsonPath}`);
    console.log(`🧱 Recovery JSONL: ${jsonlPath}`);
    console.log(`🧭 Thread index: ${indexPath}`);
    console.log(`📋 Summary: ${summaryPath}`);
  } else {
    console.log('🧹 Raw JSON/JSONL/index/summary removed.');
    console.log('📦 Kept memory_chunks\\, perplexity-memory.md, perplexity-export-state.json and last-thread-id.txt');
  }
  console.log('='.repeat(60));

  console.log('\n✅ Done! Closing browser in 5 seconds...');
  await page.waitForTimeout(5000);
}
