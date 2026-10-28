import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { cardOf, insertRoutines, openRoutines, reopenRoutines } from './helpers/routines';

/**
 * UI-REFONTE-05 — Routines sur iPhone (docs/maquettes-refonte/Routines-v2.html). Horloge figée au mercredi 23 sept. 2026 (semaine du 21 au
 * 27 sept.). Synthèse de la semaine, carte sans icône ni compteur « 0/0 », ligne d'informations en toutes lettres, « Modifier », rangée du
 * bas « Rapport du mois » + « Routine », aide retirée, thème sombre, largeur. Projets `iphone` et `iphone-webkit` ; PC couvert par R-01 à R-07.
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

test.describe('UI-REFONTE-05 — Routines iPhone', () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), 'Mise en page iPhone seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : synthèse, cartes, rangée du bas (critères 1 à 5)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
      await openApp(page);
      await insertRoutines(page, [
        { title: 'Boire de l’eau', space: 'perso', time: '08:30', icon: 'lucide:droplet', done: ['2026-09-21', '2026-09-22'] },
        { title: 'Sport', space: 'perso', time: '18:00', scheduleType: 'weekdays', weekdays: [2, 5], done: ['2026-09-22'] },
      ]);
      await reopenRoutines(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
      await expect(page.locator('.ct-routines__summary')).toHaveText('Semaine du 21 au 27 sept. · 3 sur 9 faites');
      await expect(page.locator('.ct-routines__rule')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Vue compacte' })).toHaveCount(0);
      await expect(page.getByText('Gérez vos routines ici', { exact: false })).toHaveCount(0);

      const water = cardOf(page, 'Boire de l’eau');
      await expect(water.getByRole('button', { name: 'Modifier la routine Boire de l’eau' })).toHaveText('Modifier');
      await expect(water.locator('svg')).toHaveCount(0);
      await expect(water.locator('.ct-routine-card__week [role="checkbox"]')).toHaveCount(7);
      await expect(water.locator('.ct-routine-card__week .ct-routine-card__counter')).toHaveCount(0);
      // Les séries en cours (R-04) restent dans la ligne : lundi et mardi validés, « série 2 jours » ; Sport mardi, « série 1 séance ».
      await expect(water.locator('.ct-routine-card__info')).toHaveText('08:30 · Perso · tous les jours · série 2 jours · 2 sur 7 cette semaine');
      await expect(cardOf(page, 'Sport').locator('.ct-routine-card__info')).toHaveText('18:00 · Perso · mardi et vendredi · série 1 séance · 1 sur 2 cette semaine');
      // Valider mercredi (aujourd'hui) : la phrase et la synthèse suivent.
      await water.getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
      await expect(water.locator('.ct-routine-card__counter')).toHaveText('3 sur 7 cette semaine');
      await expect(page.locator('.ct-routines__summary')).toHaveText('Semaine du 21 au 27 sept. · 4 sur 9 faites');

      const row = page.locator('.ct-routines__bottomRow');
      await expect(row.getByRole('button', { name: 'Rapport du mois' })).toBeVisible();
      const add = row.getByRole('button', { name: 'Ajouter une routine' });
      await expect(add).toHaveText(/Routine$/);
      await expect(page.locator('.ct-fab')).toHaveCount(0);
      const box = await row.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.y + box.height <= viewport.height).toBeTruthy();
      await expectFitsViewport(page, `Routines (${scheme})`);
    });
  }

  test('« Routine » ouvre la feuille Ajout au segment Routine ; la synthèse accueille la nouvelle (critère 4)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
    await openApp(page);
    await openRoutines(page);
    await expect(page.locator('.ct-routines__summary')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ajouter une routine' }).click();
    const form = page.getByRole('form', { name: 'Nouvelle routine' });
    await expect(form).toBeVisible();
    await form.getByLabel('Nom de la routine').fill('Lire');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).toBeHidden();
    await expect(cardOf(page, 'Lire').locator('.ct-routine-card__info')).toHaveText(/^tous les jours · 0 sur \d cette semaine$/);
    await expect(page.locator('.ct-routines__summary')).toHaveText(/^Semaine du 21 au 27 sept\. · 0 sur \d faite/);
  });
});
