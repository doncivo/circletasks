import type { Page } from '@playwright/test';

/** Deux images affichées : le premier calage de chaque roue et les transitions d'entrée sont posés. Attente d'état, pas un délai. */
export async function afterFirstFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
