import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import type { BrowserConsole } from '../browser/console-overlay.js';
import { updateStatusBadge } from '../browser/status-badge.js';
import { fetchThread } from './api.js';
import type { ExportResult, ThreadData, ThreadLink } from '../types.js';

export interface ExportThreadsOptions {
  jsonPath?: string;
  jsonlPath?: string;
  failedPath?: string;
  delayMs?: number;

  /**
   * Number of threads to fetch in parallel. Keep conservative because the
   * endpoint is unofficial and can throttle during large exports.
   */
  concurrency?: number;

  /**
   * Number of attempts per thread. Perplexity can intermittently return
   * non-OK responses while exporting many threads, so retry before writing
   * an http_error placeholder.
   */
  retryCount?: number;

  /**
   * Base delay for retries. Actual wait uses a small linear backoff:
   * retryBaseDelayMs * attemptNumber.
   */
  retryBaseDelayMs?: number;
}

type FetchThreadResult = Awaited<ReturnType<typeof fetchThread>>;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function toExportRecord(
  thread: ThreadLink,
  status: 'ok' | 'no_steps' | 'http_error' | 'exception',
  data: ThreadData | null,
  stepCount: number,
  error?: string
): ThreadData {
  const base = data && typeof data === 'object' ? data : {};

  return {
    ...base,
    __export: {
      id: thread.id,
      slug: thread.slug,
      title: thread.title,
      url: thread.url,
      status,
      stepCount,
      error,
      exportedAt: new Date().toISOString(),
    },
  };
}

async function appendLine(filePath: string | undefined, value: unknown): Promise<void> {
  if (!filePath) return;
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function fetchThreadWithRetry(
  page: Page,
  thread: ThreadLink,
  overlay: BrowserConsole,
  retryCount: number,
  retryBaseDelayMs: number
): Promise<FetchThreadResult> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      const result = await fetchThread(page, thread);

      if (result) {
        return result;
      }

      lastError = new Error('HTTP error or non-OK response');
    } catch (error) {
      lastError = error;
    }

    if (attempt < retryCount) {
      const waitMs = retryBaseDelayMs * attempt;
      const msg = `          ↻ Retry ${attempt}/${retryCount - 1} after HTTP/error, waiting ${waitMs} ms`;
      console.warn(msg);
      await overlay.log(msg, '#ffaa00').catch(() => undefined);
      await page.waitForTimeout(waitMs);
    }
  }

  if (lastError instanceof Error && lastError.message !== 'HTTP error or non-OK response') {
    throw lastError;
  }

  return null;
}

/**
 * Iterates through all thread links, fetches each one, and streams progress
 * to the terminal, the browser overlay console, and optional disk files.
 *
 * The JSONL file is append-only and is the safest recovery file if the run is
 * interrupted. The JSON file is written as a streamed JSON array and becomes
 * valid after the exporter finishes normally.
 */
export async function exportThreads(
  page: Page,
  threads: ThreadLink[],
  overlay: BrowserConsole,
  options: ExportThreadsOptions = {}
): Promise<ExportResult> {
  const log: string[] = [];
  let successCount = 0;
  let errorCount = 0;
  let firstJsonRecord = true;
  const completedThreadIds: string[] = [];
  const noStepThreadIds: string[] = [];
  const failedThreadIds: string[] = [];

  const delayMs = Math.max(0, options.delayMs ?? 900);
  const retryCount = Math.max(1, options.retryCount ?? 4);
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 1800;
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 1)));

  // Safety dedupe by true thread id. Repeated titles are allowed, repeated IDs are not.
  const uniqueById = new Map<string, ThreadLink>();
  for (const thread of threads) {
    if (!thread?.id) continue;
    if (!uniqueById.has(thread.id)) {
      uniqueById.set(thread.id, thread);
    }
  }

  const exportList = [...uniqueById.values()];

  if (exportList.length !== threads.length) {
    const removed = threads.length - exportList.length;
    console.warn(`⚠️ Removed ${removed} duplicated thread IDs before export.`);
    await overlay.log(`⚠️ Removed ${removed} duplicated thread IDs before export`, '#ffaa00');
  }

  if (options.jsonPath) {
    await fs.writeFile(options.jsonPath, '[\n', 'utf8');
  }

  if (options.jsonlPath) {
    await fs.writeFile(options.jsonlPath, '', 'utf8');
  }

  if (options.failedPath) {
    await fs.writeFile(options.failedPath, '', 'utf8');
  }

  let persistQueue = Promise.resolve();

  function persistRecord(record: ThreadData): Promise<void> {
    persistQueue = persistQueue.then(async () => {
      if (options.jsonPath) {
        const prefix = firstJsonRecord ? '' : ',\n';
        await fs.appendFile(options.jsonPath, `${prefix}${JSON.stringify(record, null, 2)}`, 'utf8');
        firstJsonRecord = false;
      }

      await appendLine(options.jsonlPath, record);
    });

    return persistQueue;
  }

  await overlay.log(
    `📦 Found ${exportList.length} unique threads to export | concurrency=${concurrency} | delay=${delayMs}ms`,
    '#00bfff'
  );
  await overlay.log('━'.repeat(60), '#444444');

  let nextIndex = 0;
  let finishedCount = 0;

  async function exportOne(thread: ThreadLink, index: number): Promise<void> {
    const progress = `[${index + 1}/${exportList.length}]`;
    const displayTitle = truncate(thread.title, 50);

    console.log(`${progress} queued - ${displayTitle}`);
    log.push(`${progress} ${displayTitle}`);
    await overlay.log(`${progress} queued - ${displayTitle}`, '#ffffff');

    try {
      const result = await fetchThreadWithRetry(
        page,
        thread,
        overlay,
        retryCount,
        retryBaseDelayMs
      );

      if (result) {
        const status = result.stepCount > 0 ? 'ok' : 'no_steps';
        const record = toExportRecord(thread, status, result.data, result.stepCount);
        await persistRecord(record);

        log.push(`  ✅ ${result.stepCount} steps`);

        if (result.stepCount > 0) {
          await overlay.log(`          ✅ ${result.stepCount} steps downloaded + saved`, '#00ff00');
        } else {
          const failedInfo = {
            id: thread.id,
            title: thread.title,
            url: thread.url,
            status: 'no_steps',
            stepCount: result.stepCount,
          };
          await appendLine(options.failedPath, failedInfo);
          await overlay.log(`          ⚠️  No steps found, saved anyway`, '#ffaa00');
          console.warn(`          Warning: Thread "${thread.title}" has no steps.`);
        }

        completedThreadIds.push(thread.id);
        if (status === 'no_steps') noStepThreadIds.push(thread.id);

        successCount++;
      } else {
        const record = toExportRecord(
          thread,
          'http_error',
          null,
          0,
          `HTTP error or non-OK response after ${retryCount} attempts`
        );
        await persistRecord(record);
        await appendLine(options.failedPath, record.__export);

        log.push(`  ⚠️ HTTP error after retries`);
        await overlay.log(`          ⚠️  HTTP error after retries, placeholder saved`, '#ffaa00');
        failedThreadIds.push(thread.id);
        errorCount++;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const record = toExportRecord(thread, 'exception', null, 0, msg);
      await persistRecord(record);
      await appendLine(options.failedPath, record.__export);

      log.push(`  ❌ Error: ${msg}`);
      await overlay.log(`          ❌ Error saved: ${msg}`, '#ff4444');
      failedThreadIds.push(thread.id);
      errorCount++;
    } finally {
      finishedCount++;
      const percentage = Math.round((finishedCount / exportList.length) * 100);

      await updateStatusBadge(page, {
        background: '#f59e0b',
        html:
          `Exporting Threads | ${percentage}% | ${finishedCount} / ${exportList.length} | ` +
          truncate(thread.title, 30),
      });

      if (delayMs > 0) {
        await page.waitForTimeout(delayMs);
      }
    }
  }

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= exportList.length) return;

      const thread = exportList[index];
      if (!thread) continue;

      await overlay.log(`          ▶ worker ${workerId}: ${truncate(thread.title, 42)}`, '#999999');
      await exportOne(thread, index);
    }
  }

  try {
    const workerCount = Math.min(concurrency, exportList.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));
    await persistQueue;
  } finally {
    if (options.jsonPath) {
      await fs.appendFile(options.jsonPath, '\n]\n', 'utf8');
    }
  }

  await overlay.log('━'.repeat(60), '#444444');
  await overlay.log(
    `✅ Download complete: ${successCount} successful, ${errorCount} errors`,
    '#00ff00'
  );

  await updateStatusBadge(page, {
    background: '#10b981',
    html: `Export Complete | ${successCount} successful | ${errorCount} failed`,
  });

  return {
    success: true,
    log,
    count: exportList.length,
    successCount,
    errorCount,
    completedThreadIds,
    noStepThreadIds,
    failedThreadIds,
  };
}
