import type { Page } from 'playwright';
import type { ThreadLink } from '../types.js';

/**
 * Scrapes all unique thread links accumulated during scrolling plus whatever
 * remains visible in the current DOM.
 *
 * Requires the patched scroller.ts, which fills window.__PEX_THREAD_LINKS__.
 */
export async function scrapeThreadLinks(page: Page): Promise<ThreadLink[]> {
  return page.evaluate(() => {
    /* eslint-disable no-undef */
    const w = window as any;

    const threads: Array<{ id: string; title: string; url: string; slug: string }> = [];

    function addThread(id: string, title = '') {
      if (!id) return;
      threads.push({
        id,
        title: title || id,
        url: `https://www.perplexity.ai/search/${id}`,
        slug: id,
      });
    }

    // 1) Use accumulated threads from autoScrollToLoadAll().
    const cached = Array.isArray(w.__PEX_THREAD_LINKS__) ? w.__PEX_THREAD_LINKS__ : [];
    for (const t of cached) {
      if (t?.id || t?.slug) {
        addThread(String(t.id || t.slug), String(t.title || t.id || t.slug));
      }
    }

    // 2) Also scrape currently visible anchors as fallback.
    const elements = document.querySelectorAll<HTMLAnchorElement>('a[href*="/search/"]');
    elements.forEach((el) => {
      const href = el.href;
      const title =
        el.textContent?.trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        '';

      const match = href?.match(/\/search\/([^/?#]+)/);
      if (match?.[1]) {
        addThread(match[1], title || match[1]);
      }
    });

    // Deduplicate by thread ID.
    return [...new Map(threads.map((t) => [t.id, t])).values()];
  });
}
