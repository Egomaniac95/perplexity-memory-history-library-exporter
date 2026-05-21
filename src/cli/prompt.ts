import readline from 'node:readline';
import type { Page } from 'playwright';
import { BrowserConsole } from '../browser/console-overlay.js';

export function waitForEnter(prompt = 'Press ENTER when ready... '): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question(prompt, (_answer: string) => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Automatic save-location resolver.
 *
 * Returns "current" without asking the user. This keeps the exporter fully
 * unattended after login and avoids the terminal prompt:
 *
 *   Choice [1-4] (Enter = current):
 */
export async function promptSaveLocation(
  _page?: Page,
  overlay?: BrowserConsole
): Promise<string> {
  const result = 'current';

  console.log('\n💾 Save location: current folder (automatic)\n');

  if (overlay) {
    await overlay.log('💾 Saving to: current folder', '#00bfff').catch(() => undefined);
  }

  return result;
}
