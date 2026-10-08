import { expect, test } from '@playwright/test';
import { openCalendarsScreen } from './helpers/calendars';

/**
 * K-07 — Je retrouve mes Rappels Apple sur le PC (projet `pc`). La section est en lecture seule : aucune connexion, aucun choix de liste,
 * aucun appel de plugin. Les cas de fraîcheur (bornes de 24 h, appareil oublié), le compteur de modifications en attente et le passage à
 * deux appareils sont couverts par Vitest (`AppleRemindersReadOnly.test.tsx`, `twoDevices.test.ts`, banc de synchro).
 */
test.describe('K-07 — Rappels Apple sur le PC', () => {
  test('section en lecture seule : explication, aucune liste suivie, « Se règle sur l’iPhone », ni case ni bouton de connexion', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'PC seulement');
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    await openCalendarsScreen(page);
    const section = page.getByRole('region', { name: 'RAPPELS APPLE' });
    await expect(section.getByText('Les Rappels Apple se lisent sur l’iPhone et arrivent ici par la synchro.')).toBeVisible();
    await expect(section.getByText('Aucune liste n’est suivie pour le moment.')).toBeVisible();
    await expect(section.getByText('Se règle sur l’iPhone')).toBeVisible();
    await expect(section.getByRole('checkbox')).toHaveCount(0);
    await expect(section.getByRole('button')).toHaveCount(0);
  });
});
