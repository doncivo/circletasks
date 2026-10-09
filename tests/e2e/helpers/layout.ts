import { expect, type Page } from '@playwright/test';

/**
 * Y-IOS-02 (QA du parcours d'association) : l'écran tient dans la largeur de la fenêtre (440 pour l'iPhone 16 Pro Max) : pas de défilement
 * horizontal de la page, et aucun élément visible qui dépasse à droite ou à gauche (la page « débordait à droite » sur l'iPhone en 0.2.1).
 * `where` nomme l'écran dans le message d'échec.
 */
export async function expectFitsViewport(page: Page, where: string): Promise<void> {
  const report = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const root = document.scrollingElement ?? document.documentElement;
    const offenders: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (element.closest('[aria-hidden="true"], .ct-visually-hidden')) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > viewport + 0.5 || rect.left < -0.5) offenders.push(`${element.tagName.toLowerCase()}.${String(element.className)} [${String(Math.round(rect.left))}..${String(Math.round(rect.right))}]`);
    }
    return { scroll: root.scrollWidth, client: root.clientWidth, viewport, offenders: offenders.slice(0, 5) };
  });
  expect(report.scroll, `${where} : défilement horizontal de la page`).toBeLessThanOrEqual(report.client);
  expect(report.offenders, `${where} : éléments hors de la largeur ${String(report.viewport)}`).toEqual([]);
}
