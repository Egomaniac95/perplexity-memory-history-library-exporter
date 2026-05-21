import type { Page } from 'playwright';

export async function isLoggedIn(page: Page): Promise<boolean> {
  return (await page.locator('a[href*="/library"]').count()) > 0;
}

export async function ensureLoggedIn(page: Page): Promise<void> {
  console.log('⚠️ Log in to Perplexity manually if needed.');
  console.log('When your account is active and you can open the Library, return to PowerShell.');
  console.log('Press ENTER to continue...\n');

  const readline = await import('readline');
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press ENTER when ready... ', () => {
      rl.close();
      resolve();
    });
  });
}

export async function navigateToLibrary(page: Page): Promise<void> {
  console.log('📚 Navigating to Library...');
  await page.goto('https://www.perplexity.ai/library', { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForSelector('a[href*="/search/"]', { timeout: 30000 });
  } catch {
    console.log('⚠️ No threads found or page not loaded properly');
  }

  await page.waitForTimeout(3000);
}


