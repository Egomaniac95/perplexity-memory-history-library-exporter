import type { Page, Response } from 'playwright';
import {
  updateStatusBadge,
  flashScrollContainer,
  removeScrollContainerHighlight,
} from './status-badge.js';

export interface ScrollOptions {
  maxAttempts?: number;
  stableThreshold?: number;
  waitMs?: number;
  itemSelector?: string;
  recoveryCycles?: number;
  minExpectedThreads?: number;

  /**
   * Incremental mode: stop scrolling once one of these already-exported
   * thread IDs appears in the accumulated Library results.
   */
  stopAtThreadIds?: string[];

  /** Number of extra scroll iterations after the first known thread is seen. */
  stopAfterKnownSeenAttempts?: number;

  /**
   * Full-export mode: how many recovery cycles may repeat with no new
   * accumulated threads, no new network threads, and no height change before
   * treating the Library bottom as the real end.
   *
   * This prevents long loops such as Recovery 70/1000 when Perplexity is
   * already at the end of the Library.
   */
  maxFailedRecoveryCycles?: number;
}

type ThreadCacheItem = {
  id: string;
  title: string;
  url: string;
  slug: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function isGoodTitle(value: string): boolean {
  return value.length > 2 && value.length < 300 && !UUID_RE.test(value);
}

function pushThread(out: Map<string, ThreadCacheItem>, id: string, rawTitle?: unknown): void {
  if (!isThreadId(id)) return;

  const title = normalizeTitle(rawTitle);
  const existing = out.get(id);

  const finalTitle = isGoodTitle(title)
    ? title
    : existing?.title && existing.title !== existing.id
      ? existing.title
      : id;

  out.set(id, {
    id,
    title: finalTitle,
    url: `https://www.perplexity.ai/search/${id}`,
    slug: id,
  });
}

function getString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Extracts UUIDs only from real Perplexity search URLs.
 *
 * Supports both:
 *   /search/<uuid>
 *   /search/<human-slug>-<uuid>
 */
function extractSearchUuidsFromString(value: string): string[] {
  if (!value.includes('/search/')) return [];

  const ids = new Set<string>();
  const searchSegments = value.match(/\/search\/[^"'\s?#)]+/gi) ?? [];

  for (const segment of searchSegments) {
    const matches = segment.match(UUID_GLOBAL_RE) ?? [];
    for (const id of matches) ids.add(id);
  }

  return [...ids];
}

/**
 * Perplexity payloads contain many UUIDs that are NOT valid thread URLs:
 * frontend_uuid, frontend_context_uuid, context_uuid, author_id, entry uuid, etc.
 *
 * The safe rule is:
 * - Always accept explicit /search/<uuid> URLs.
 * - Prefer canonical thread_url_slug / backend_uuid / thread_uuid.
 * - Accept uuid/id only when the object looks like a library thread item and
 *   does not already expose a better canonical field.
 */
function extractThreadItemsFromUnknown(
  value: unknown,
  out: Map<string, ThreadCacheItem>,
  depth = 0
): void {
  if (depth > 12 || value == null) return;

  if (typeof value === 'string') {
    for (const id of extractSearchUuidsFromString(value)) {
      pushThread(out, id);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractThreadItemsFromUnknown(item, out, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;

  const obj = value as Record<string, unknown>;

  const titleCandidates = [
    obj.thread_title,
    obj.title,
    obj.display_title,
    obj.displayTitle,
    obj.query,
    obj.query_str,
    obj.queryStr,
    obj.question,
    obj.prompt,
    obj.name,
  ]
    .map(normalizeTitle)
    .filter((t) => t.length > 0);

  const bestTitle = titleCandidates.find(isGoodTitle) || '';

  let explicitSearchUrlFound = false;

  const hrefCandidates = [
    obj.url,
    obj.href,
    obj.link,
    obj.permalink,
    obj.share_url,
    obj.thread_url,
  ].filter((x): x is string => typeof x === 'string');

  for (const href of hrefCandidates) {
    const ids = extractSearchUuidsFromString(href);
    if (ids.length > 0) explicitSearchUrlFound = true;
    for (const id of ids) pushThread(out, id, bestTitle);
  }

  const canonicalCandidates = [
    getString(obj, 'thread_url_slug'),
    getString(obj, 'backend_uuid'),
    getString(obj, 'thread_uuid'),
    getString(obj, 'thread_id'),
    getString(obj, 'threadId'),
  ].filter(isThreadId);

  if (canonicalCandidates.length > 0) {
    for (const id of canonicalCandidates) pushThread(out, id, bestTitle);
  } else if (!explicitSearchUrlFound) {
    const possibleLibraryThread =
      isGoodTitle(bestTitle) &&
      (
        typeof obj.uuid === 'string' ||
        typeof obj.id === 'string' ||
        typeof obj.slug === 'string' ||
        typeof obj.permalink_uuid === 'string' ||
        typeof obj.search_id === 'string'
      ) &&
      // Step/entry objects can have uuid, but they are not threads.
      typeof obj.step_type !== 'string' &&
      typeof obj.role !== 'string';

    if (possibleLibraryThread) {
      const fallbackCandidates = [
        getString(obj, 'uuid'),
        getString(obj, 'id'),
        getString(obj, 'slug'),
        getString(obj, 'permalink_uuid'),
        getString(obj, 'search_id'),
      ].filter(isThreadId);

      for (const id of fallbackCandidates) pushThread(out, id, bestTitle);
    }
  }

  for (const child of Object.values(obj)) {
    extractThreadItemsFromUnknown(child, out, depth + 1);
  }
}

async function hardScrollRecovery(page: Page, round: number, waitMs: number): Promise<void> {
  console.log(`   🛠️  Recovery scroll cycle ${round}`);

  const box = await page.evaluate(async ({ round }) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function getScrollableCandidates() {
      const all = Array.from(document.querySelectorAll<HTMLElement>('body, body *'));

      return all
        .map((el, index) => {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          const scrollable =
            (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
            el.scrollHeight > el.clientHeight + 20;

          const rect = el.getBoundingClientRect();
          const visible =
            rect.width > 100 &&
            rect.height > 100 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;

          const delta = el.scrollHeight - el.clientHeight;
          return { el, index, scrollable, visible, delta };
        })
        .filter((x) => x.scrollable && x.visible)
        .sort((a, b) => b.delta - a.delta);
    }

    function fireScrollEvents(el: HTMLElement) {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.max(900, el.clientHeight), bubbles: true }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    const candidates = getScrollableCandidates();
    const target = candidates[0]?.el ?? document.scrollingElement ?? document.documentElement;
    const targetEl = target as HTMLElement;

    const lastAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/search/"]')).at(-1);
    if (lastAnchor) {
      lastAnchor.scrollIntoView({ block: 'end', inline: 'nearest' });
      await sleep(150);
    }

    for (let i = 0; i < 3; i++) {
      const up = Math.max(140, Math.floor(targetEl.clientHeight * 0.25));
      const down = Math.max(2600, Math.floor(targetEl.clientHeight * 3.0));

      targetEl.scrollTop = Math.max(0, targetEl.scrollTop - up);
      fireScrollEvents(targetEl);
      await sleep(80);

      targetEl.scrollTop = Math.min(
        Math.max(0, targetEl.scrollHeight - targetEl.clientHeight),
        targetEl.scrollTop + down + round * 75
      );
      fireScrollEvents(targetEl);
      await sleep(160);
    }

    const rect = targetEl.getBoundingClientRect();
    return {
      x: Math.max(10, Math.min(window.innerWidth - 10, rect.left + rect.width / 2)),
      y: Math.max(10, Math.min(window.innerHeight - 10, rect.top + rect.height / 2)),
    };
  }, { round });

  await page.mouse.move(box.x, box.y).catch(() => undefined);

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 4200 + round * 200).catch(() => undefined);
    await page.waitForTimeout(Math.max(55, Math.floor(waitMs / 7)));
  }

  await page.keyboard.press('PageDown').catch(() => undefined);
  await page.waitForTimeout(waitMs);
}

export async function autoScrollToLoadAll(page: Page, opts: ScrollOptions = {}): Promise<number> {
  const {
    maxAttempts = 20000,
    stableThreshold = 4,
    waitMs = 250,
    itemSelector = 'a[href*="/search/"]',
    recoveryCycles = 500,
    minExpectedThreads = 0,
    stopAtThreadIds = [],
    stopAfterKnownSeenAttempts = 2,
    maxFailedRecoveryCycles = 40,
  } = opts;

  const networkThreads = new Map<string, ThreadCacheItem>();

  const responseHandler = async (response: Response): Promise<void> => {
    const url = response.url();

    if (!url.includes('perplexity.ai')) return;
    if (!/\/rest\/|\/api\/|thread|library|search|graphql|profile|collections?/i.test(url)) return;

    try {
      const contentType = response.headers()['content-type'] ?? '';

      if (
        !contentType.includes('application/json') &&
        !contentType.includes('text/json') &&
        !contentType.includes('application/x-ndjson')
      ) {
        return;
      }

      const json = await response.json();
      extractThreadItemsFromUnknown(json, networkThreads);
    } catch {
      // streamed/cached/opaque/already consumed responses can fail here
    }
  };

  page.on('response', responseHandler);

  await page.evaluate(() => {
    const w = window as any;
    w.__PEX_THREAD_LINKS__ = [];
  });

  let scrollAttempts = 0;
  let stableCount = 0;
  let bottomStuckCount = 0;
  let previousSignature = '';
  let previousCount = 0;
  let previousHeight = 0;
  let finalCount = 0;
  let recoveryRound = 0;
  let knownSeenRounds = 0;

  // Tracks repeated recovery attempts that produce no new content.
  let failedRecoveryCycles = 0;
  let lastRecoveryCount = -1;
  let lastRecoveryHeight = -1;
  let lastRecoveryNetworkCount = -1;

  try {
    while (scrollAttempts < maxAttempts) {
      const scrollInfo = await page.evaluate(
        async ({ selector, networkItems, stopAtIds }) => {
          const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
          const w = window as any;

          const cache: ThreadCacheItem[] = Array.isArray(w.__PEX_THREAD_LINKS__)
            ? w.__PEX_THREAD_LINKS__
            : [];

          const byId = new Map<string, ThreadCacheItem>(cache.map((t) => [t.id, t]));
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const uuidGlobalRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

          function cleanTitle(value: string) {
            return (value || '').replace(/\s+/g, ' ').trim();
          }

          function goodTitle(value: string) {
            return value.length > 2 && value.length < 300 && !uuidRe.test(value);
          }

          function addThread(id: string, title = '') {
            if (!uuidRe.test(id)) return;

            const existing = byId.get(id);
            const titleClean = cleanTitle(title);

            const finalTitle =
              goodTitle(titleClean)
                ? titleClean
                : existing?.title && existing.title !== existing.id
                  ? existing.title
                  : id;

            byId.set(id, {
              id,
              title: finalTitle,
              url: `https://www.perplexity.ai/search/${id}`,
              slug: id,
            });
          }

          function idsFromSearchHref(href: string): string[] {
            if (!href.includes('/search/')) return [];
            return [...new Set(href.match(uuidGlobalRe) ?? [])];
          }

          function collectVisibleThreadAnchors() {
            const currentAnchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
            const currentVisibleTitles: string[] = [];

            for (const a of currentAnchors) {
              const href = a.href || '';
              const ids = idsFromSearchHref(href);
              const title =
                cleanTitle(a.textContent || '') ||
                cleanTitle(a.getAttribute('aria-label') || '') ||
                cleanTitle(a.getAttribute('title') || '');

              if (title) currentVisibleTitles.push(title);

              for (const id of ids) {
                addThread(id, title || id);
              }
            }

            return { anchors: currentAnchors, visibleTitles: currentVisibleTitles };
          }

          function getScrollableCandidates() {
            const all = Array.from(document.querySelectorAll<HTMLElement>('body, body *'));

            const candidates = all
              .map((el, index) => {
                const style = window.getComputedStyle(el);
                const overflowY = style.overflowY;
                const scrollable =
                  (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
                  el.scrollHeight > el.clientHeight + 20;

                const rect = el.getBoundingClientRect();
                const visible =
                  rect.width > 100 &&
                  rect.height > 100 &&
                  rect.bottom > 0 &&
                  rect.right > 0 &&
                  rect.top < window.innerHeight &&
                  rect.left < window.innerWidth;

                const delta = el.scrollHeight - el.clientHeight;
                const bottomGap = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);

                return {
                  index,
                  tag: el.tagName.toLowerCase(),
                  id: el.id || '',
                  className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
                  scrollTop: el.scrollTop,
                  scrollHeight: el.scrollHeight,
                  clientHeight: el.clientHeight,
                  delta,
                  bottomGap,
                  scrollable,
                  visible,
                };
              })
              .filter((x) => x.scrollable && x.visible)
              .sort((a, b) => b.delta - a.delta)
              .slice(0, 10);

            return { all, candidates, best: candidates[0] };
          }

          function fireScrollEvents(el: HTMLElement, deltaY: number) {
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
            el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
            document.dispatchEvent(new Event('scroll', { bubbles: true }));
            window.dispatchEvent(new Event('scroll', { bubbles: true }));
          }

          for (const item of networkItems as ThreadCacheItem[]) {
            addThread(item.id, item.title);
          }

          let { anchors, visibleTitles } = collectVisibleThreadAnchors();

          // Fast burst: fewer Node<->browser round trips, but still recaptures anchors
          // after each movement so virtualized Library items are not skipped.
          const burstCount = byId.size < 1500 ? 3 : 2;

          for (let burst = 0; burst < burstCount; burst++) {
            const { all, best } = getScrollableCandidates();

            if (best) {
              const el = all[best.index];
              if (el) {
                const step = Math.max(2600, Math.floor(el.clientHeight * 3.4));
                const beforeTop = el.scrollTop;

                el.scrollBy({ top: step, behavior: 'auto' });

                if (Math.abs(el.scrollTop - beforeTop) < 2) {
                  el.scrollTop = Math.min(
                    Math.max(0, el.scrollHeight - el.clientHeight),
                    el.scrollTop + step
                  );
                }

                fireScrollEvents(el, step);
              }
            } else {
              const step = Math.max(2600, Math.floor(window.innerHeight * 3.4));
              window.scrollBy(0, step);
              document.documentElement.scrollTop += step;
              document.body.scrollTop += step;
              document.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
              window.dispatchEvent(new Event('scroll', { bubbles: true }));
            }

            await sleep(140);
            ({ anchors, visibleTitles } = collectVisibleThreadAnchors());
          }

          const { candidates, best } = getScrollableCandidates();
          w.__PEX_THREAD_LINKS__ = [...byId.values()];

          const titledCount = [...byId.values()].filter((t) => t.title && t.title !== t.id).length;

          const knownSeen = (stopAtIds as string[]).filter((id) => byId.has(id));

          const duplicateTitleCount = (() => {
            const seen = new Set<string>();
            let duplicates = 0;

            for (const t of byId.values()) {
              const key = (t.title || '').toLowerCase();
              if (!key || key === t.id) continue;
              if (seen.has(key)) duplicates++;
              else seen.add(key);
            }

            return duplicates;
          })();

          const signature = JSON.stringify({
            count: byId.size,
            titledCount,
            networkCount: (networkItems as ThreadCacheItem[]).length,
            top: Math.round(best?.scrollTop ?? window.scrollY),
            height: Math.round(best?.scrollHeight ?? document.body.scrollHeight),
            bottomGap: Math.round(best?.bottomGap ?? 0),
            firstVisibleHref: anchors[0]?.href || '',
            lastVisibleHref: anchors.at(-1)?.href || '',
            firstVisibleTitle: visibleTitles[0] || '',
            lastVisibleTitle: visibleTitles.at(-1) || '',
          });

          return {
            accumulatedCount: byId.size,
            titledCount,
            duplicateTitleCount,
            visibleAnchors: anchors.length,
            networkCount: (networkItems as ThreadCacheItem[]).length,
            knownSeenCount: knownSeen.length,
            firstKnownSeenId: knownSeen[0] || '',
            firstKnownSeenTitle: knownSeen[0] ? byId.get(knownSeen[0])?.title || '' : '',
            bestScroller: best
              ? `${best.tag}${best.id ? `#${best.id}` : ''}${best.className ? `.${best.className.replace(/\s+/g, '.')}` : ''}`
              : 'none',
            bestScrollTop: best?.scrollTop ?? window.scrollY,
            bestScrollHeight: best?.scrollHeight ?? document.body.scrollHeight,
            bestClientHeight: best?.clientHeight ?? window.innerHeight,
            bestBottomGap: best?.bottomGap ?? 0,
            candidateCount: candidates.length,
            signature,
          };
        },
        { selector: itemSelector, networkItems: [...networkThreads.values()], stopAtIds: stopAtThreadIds }
      );

      finalCount = scrollInfo.accumulatedCount;

      const shouldPrintProgress =
        scrollAttempts < 10 ||
        (scrollAttempts + 1) % 5 === 0 ||
        scrollInfo.accumulatedCount !== previousCount ||
        scrollInfo.bestBottomGap <= 2;

      if (shouldPrintProgress) {
        console.log(
          `   📊 Scroll ${scrollAttempts + 1}: accumulated=${scrollInfo.accumulatedCount}, titled=${scrollInfo.titledCount}, duplicateTitles=${scrollInfo.duplicateTitleCount}, visible=${scrollInfo.visibleAnchors}, network=${scrollInfo.networkCount}`
        );
        console.log(
          `       scroller=${scrollInfo.bestScroller}, top=${scrollInfo.bestScrollTop}, height=${scrollInfo.bestScrollHeight}, client=${scrollInfo.bestClientHeight}, bottomGap=${scrollInfo.bestBottomGap}, candidates=${scrollInfo.candidateCount}`
        );
      }

      if ((scrollAttempts + 1) % 5 === 0) {
        await updateStatusBadge(page, {
          html: `Auto-Scrolling | Attempt ${scrollAttempts + 1} | Threads ${scrollInfo.accumulatedCount} | Titled ${scrollInfo.titledCount}`,
        });
      }

      if (stopAtThreadIds.length > 0 && scrollInfo.knownSeenCount > 0) {
        knownSeenRounds++;
        console.log(
          `   🧭 Known thread reached (${knownSeenRounds}/${stopAfterKnownSeenAttempts}): ${scrollInfo.firstKnownSeenTitle || scrollInfo.firstKnownSeenId}`
        );

        if (knownSeenRounds >= stopAfterKnownSeenAttempts) {
          console.log(
            `   ✅ Incremental boundary found. Stopping scroll at ${scrollInfo.accumulatedCount} accumulated threads.\n`
          );
          break;
        }
      }

      const countIncreased = scrollInfo.accumulatedCount > previousCount;
      const heightIncreased = scrollInfo.bestScrollHeight > previousHeight + 2;
      const nearBottom = scrollInfo.bestBottomGap <= 2;
      const signatureChanged = scrollInfo.signature !== previousSignature;

      const meaningfulMovement = countIncreased || heightIncreased || (signatureChanged && !nearBottom);
      // After a few hundred accumulated threads Perplexity often pauses at the virtualized
      // list bottom even though older chunks still exist. Trigger recovery one stable tick
      // earlier in that zone to avoid wasting three full polling cycles per chunk.
      const bottomStuckThreshold = scrollInfo.accumulatedCount >= 300 ? 2 : 3;

      if (meaningfulMovement) {
        stableCount = 0;
        if (countIncreased || heightIncreased || !nearBottom) bottomStuckCount = 0;

        // Any real progress means previous recovery attempts were useful.
        failedRecoveryCycles = 0;
        lastRecoveryCount = scrollInfo.accumulatedCount;
        lastRecoveryHeight = scrollInfo.bestScrollHeight;
        lastRecoveryNetworkCount = scrollInfo.networkCount;

        console.log('   📈 Movement or new content detected');
      } else {
        stableCount++;
        bottomStuckCount = nearBottom && !countIncreased && !heightIncreased ? bottomStuckCount + 1 : 0;
        console.log(`   ⏸️  Stable (${stableCount}/${stableThreshold}) | bottom-stuck=${bottomStuckCount}/${bottomStuckThreshold}`);
      }

      const belowExpected = minExpectedThreads > 0 && scrollInfo.accumulatedCount < minExpectedThreads;
      const shouldRecover = bottomStuckCount >= bottomStuckThreshold || stableCount >= stableThreshold;

      if (shouldRecover) {
        const allowedRecoveryCycles = belowExpected ? recoveryCycles * 3 : recoveryCycles;
        const recoveryPlateau =
          nearBottom &&
          scrollInfo.accumulatedCount === lastRecoveryCount &&
          scrollInfo.bestScrollHeight === lastRecoveryHeight &&
          scrollInfo.networkCount === lastRecoveryNetworkCount;

        if (recoveryPlateau) {
          failedRecoveryCycles++;
        } else {
          failedRecoveryCycles = 1;
          lastRecoveryCount = scrollInfo.accumulatedCount;
          lastRecoveryHeight = scrollInfo.bestScrollHeight;
          lastRecoveryNetworkCount = scrollInfo.networkCount;
        }

        const failedRecoveryLimit = belowExpected
          ? Math.max(maxFailedRecoveryCycles * 3, maxFailedRecoveryCycles + 6)
          : maxFailedRecoveryCycles;

        if (failedRecoveryCycles >= failedRecoveryLimit) {
          console.log(
            `   ✅ Library end confirmed: ${failedRecoveryCycles}/${failedRecoveryLimit} recovery cycles produced no new threads. ` +
            `Stopping at ${scrollInfo.accumulatedCount} accumulated threads.\n`
          );
          break;
        }

        if (recoveryRound < allowedRecoveryCycles) {
          recoveryRound++;
          stableCount = 0;
          bottomStuckCount = 0;

          console.log(
            `   ⚠️  Scroll stuck at ${scrollInfo.accumulatedCount}. ` +
            `Recovery ${recoveryRound}/${allowedRecoveryCycles} | failed=${failedRecoveryCycles}/${failedRecoveryLimit}` +
            `${belowExpected ? ` | target>=${minExpectedThreads}` : ''}...`
          );

          await hardScrollRecovery(page, recoveryRound, waitMs);
          await page.waitForTimeout(waitMs);
        } else {
          console.log(`   ✅ Scrolling finished. Accumulated threads: ${scrollInfo.accumulatedCount}\n`);
          break;
        }
      }

      if ((scrollAttempts + 1) % 10 === 0) {
        await flashScrollContainer(page).catch(() => undefined);
      }

      await page.waitForTimeout(waitMs);

      previousSignature = scrollInfo.signature;
      previousCount = scrollInfo.accumulatedCount;
      previousHeight = scrollInfo.bestScrollHeight;
      scrollAttempts++;
    }

    if (scrollAttempts >= maxAttempts) {
      console.log('   ⚠️  Reached max scroll attempts, continuing with accumulated threads\n');
    }

    await updateStatusBadge(page, {
      html: `Scrolling complete | Threads ${finalCount}`,
      background: '#10b981',
    });

    return finalCount;
  } finally {
    page.off('response', responseHandler);
    await removeScrollContainerHighlight(page).catch(() => undefined);
  }
}

