import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { filterPill } from './helpers/spaces';
import { createTask, isPhone } from './helpers/today';

/**
 * F-03 — Je vois mon temps de concentration.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris) : trois sessions de 25 min (deux sur « Envoyer la facture », une sur « Appeler
 * le notaire ») menées à leur terme par des sauts d'horloge. Couverture : pied de l'écran « Aujourd'hui : 1 h 15 de concentration · 3
 * sessions » (critère 1, 6), « 0 min » sans session (2), ligne « Concentration » de la fiche « 50 min · 2 sessions » (3), section
 * CONCENTRATION du rapport avec les tâches les plus travaillées et filtre d'espace (4, 5). Totaux par semaine, premier jour de semaine,
 * projet et 2 000 sessions : tests d'intégration et de performance. Exécuté sur `pc` et `iphone`.
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const FACTURE = 'Envoyer la facture';
const NOTAIRE = 'Appeler le notaire';

const session = (page: Page) => page.getByRole('region', { name: 'Session Focus' });
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));
const listTitle = (page: Page, name: string) => page.locator('.ct-today__list').getByRole('button', { name, exact: true });

async function launch(page: Page, testInfo: { project: { name: string } }, title: string): Promise<void> {
  await listTitle(page, title).click();
  await detail(page)
    .getByRole('button', { name: isPhone(testInfo) ? 'Lancer un Focus' : /^Focus/ })
    .click();
  await expect(session(page)).toBeVisible();
}

test.describe('F-03 — temps de concentration', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: FACTURE, time: '09:00' });
    await createTask(page, testInfo, { title: NOTAIRE });
  });

  test('le pied de l’écran suit les sessions du jour, la fiche et le rapport donnent les totaux (critères 1 à 4, 6)', async ({ page }, testInfo) => {
    await launch(page, testInfo, FACTURE);
    // Aucune session terminée : zéro (critère 2).
    await expect(session(page).getByText('Aujourd’hui : 0 min de concentration')).toBeVisible();
    await page.clock.fastForward('26:00');
    await expect(session(page).getByRole('alert')).toHaveText('Session terminée · 25 min');
    await expect(session(page).getByText('Aujourd’hui : 25 min de concentration · 1 session')).toBeVisible();
    await session(page).getByRole('button', { name: 'Une autre session' }).click();
    await page.clock.fastForward('26:00');
    await expect(session(page).getByText('Aujourd’hui : 50 min de concentration · 2 sessions')).toBeVisible();
    await session(page).getByRole('button', { name: 'Fermer', exact: true }).click();

    await launch(page, testInfo, NOTAIRE);
    await page.clock.fastForward('26:00');
    // Critère 1 : « 1 h 15 » (critère 6 : jamais « 75 min »).
    await expect(session(page).getByText('Aujourd’hui : 1 h 15 de concentration · 3 sessions')).toBeVisible();
    await session(page).getByRole('button', { name: 'Fermer', exact: true }).click();

    // Critère 3 : la fiche de la tâche.
    await listTitle(page, FACTURE).click();
    const fiche = detail(page);
    await expect(fiche.getByText('Concentration', { exact: true })).toBeVisible();
    await expect(fiche.getByText('50 min · 2 sessions')).toBeVisible();
    if (isPhone(testInfo)) await fiche.getByRole('button', { name: 'Fermer' }).click();
    else await page.keyboard.press('Escape');

    // Critère 4 : le rapport.
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    const section = page.getByRole('region', { name: 'CONCENTRATION' });
    await expect(section.getByRole('listitem').filter({ hasText: 'Aujourd’hui' })).toContainText('1 h 15');
    await expect(section.getByRole('listitem').filter({ hasText: 'Cette semaine' })).toContainText('1 h 15');
    await expect(section.getByRole('listitem').filter({ hasText: 'Ce mois' })).toContainText('1 h 15');
    await expect(section.getByRole('listitem').filter({ hasText: FACTURE })).toContainText('50 min');
    await expect(section.getByRole('listitem').filter({ hasText: NOTAIRE })).toContainText('25 min');
  });

  test('le filtre d’espace recalcule la section du rapport (critère 5)', async ({ page }, testInfo) => {
    await launch(page, testInfo, FACTURE);
    await page.clock.fastForward('26:00');
    await session(page).getByRole('button', { name: 'Fermer', exact: true }).click();
    await filterPill(page, 'Perso').click();
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    const section = page.getByRole('region', { name: 'CONCENTRATION' });
    await expect(section.getByText('Aucune session ce mois-ci.')).toBeVisible();
    await expect(section.getByRole('listitem').filter({ hasText: FACTURE })).toHaveCount(0);
  });
});
