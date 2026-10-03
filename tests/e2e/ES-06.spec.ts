import { expect, test, type Page } from '@playwright/test';
import { addIsoDays } from './helpers/schedule';
import { filterPill } from './helpers/spaces';
import { openToday } from './helpers/today';
import { browserMonday, openWeek, seedCalendarAccount, seedExternalEvent } from './helpers/week';

/**
 * ES-06 — Je rattache un agenda externe à un espace (partie de l'ordre 1 : modèle et règle).
 *
 * Aucun connecteur n'existe avant K-01 / K-02 : le compte et ses trois agendas (Travail → Pro, Famille → Perso, Libre → aucun
 * espace) sont posés en base par la prise de test du navigateur de développement (`window.__ctTest`, src/db/testHooks.ts). L'écran
 * d'affectation des agendas (critères 5 et 6) arrive avec K-01 / K-02 ; la règle (`spaceOfExternalEvent`, `validateCalendarRef`) est
 * testée en Vitest. Ici : les événements d'un agenda suivent le filtre d'espace de la Semaine. Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-06 — agendas externes et espaces', () => {
  const eventTitles = (page: Page) => page.locator('.ct-week-event').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent ?? ''));

  test('les événements d’un agenda suivent le filtre d’espace ; un agenda sans espace n’apparaît que sous « Tout » (critères 1, 3)', async ({ page }) => {
    await openToday(page);
    await seedCalendarAccount(page);
    const wednesday = addIsoDays(await browserMonday(page), 2);
    await seedExternalEvent(page, { id: 'e-pro', title: 'Point client', calendarId: 'pro', startUtc: `${wednesday}T08:00:00Z`, endUtc: `${wednesday}T09:00:00Z` });
    await seedExternalEvent(page, { id: 'e-perso', title: 'Dentiste', calendarId: 'perso', startUtc: `${wednesday}T10:00:00Z`, endUtc: `${wednesday}T11:00:00Z` });
    await seedExternalEvent(page, { id: 'e-libre', title: 'Anniversaire libre', calendarId: 'libre', startUtc: `${wednesday}T12:00:00Z`, endUtc: `${wednesday}T13:00:00Z` });
    await openWeek(page);

    const has = async (title: string) => (await eventTitles(page)).some((label) => label.includes(title));
    await expect.poll(() => has('Point client')).toBe(true);
    expect(await has('Dentiste')).toBe(true);
    expect(await has('Anniversaire libre')).toBe(true);

    await filterPill(page, 'Pro').click();
    await expect.poll(() => has('Dentiste')).toBe(false);
    expect(await has('Point client')).toBe(true);
    expect(await has('Anniversaire libre')).toBe(false);

    await filterPill(page, 'Perso').click();
    await expect.poll(() => has('Point client')).toBe(false);
    expect(await has('Dentiste')).toBe(true);
    expect(await has('Anniversaire libre')).toBe(false);

    await filterPill(page, 'Tout').click();
    await expect.poll(() => has('Anniversaire libre')).toBe(true);
  });
});
