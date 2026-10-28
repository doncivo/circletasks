import { expect, test } from '@playwright/test';
import { createTask, openToday } from './helpers/today';
import { insertTasks } from './helpers/week';

/**
 * UI-REFONTE-08 — Aujourd'hui sur PC (docs/maquettes-refonte/PC-Jour.html) : barre fixe nommée, colonne du jour bornée à 660 px avec l'agenda,
 * seconde colonne « Demain » / « Cette semaine » / « Raccourcis », champ d'ajout avec Date et Scanner, ni badge ni bouton flottant. Projet `pc`.
 */

test.describe('UI-REFONTE-08 — Aujourd’hui PC', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'pc', 'Mise en page PC seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : barre nommée, colonne du jour bornée avec l'agenda, seconde colonne (critères 1 à 4)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.clock.setFixedTime(new Date('2026-09-23T14:32:00+02:00'));
      await openToday(page); // une seule ouverture : `openToday` recharge la page, les insertions directes ne survivent pas
      await insertTasks(page, [
        { title: 'Réunion d’équipe', date: '2026-09-24', time: '11:00' },
        { title: 'Clôture mensuelle', date: '2026-09-24' },
        { title: 'Point Capgemini', date: '2026-09-25', time: '09:00' },
      ]);
      await createTask(page, test.info(), { title: 'Relire le contrat', time: '11:00' });
      await createTask(page, test.info(), { title: 'Sport', time: '18:00' });

      const bar = page.locator('.ct-today__topbar');
      await expect(bar).toBeVisible();
      for (const [name, text] of [
        ['Objectif de la semaine', 'Objectif'],
        ['Rapport mensuel', 'Rapport'],
        ['Ajouter', 'Ajouter'],
        ['Mode édition', 'Édition'],
        ['Vue compacte', 'Compacte'],
      ] as const) {
        await expect(bar.getByRole('button', { name, exact: true })).toHaveText(new RegExp(`${text}$`));
      }
      await expect(bar.getByRole('button', { name: /^Un jour/ })).toContainText('Un jour');
      await expect(bar.getByRole('button', { name: 'Rechercher' })).toBeVisible();
      await expect(page.locator('.ct-today__quickIcons')).toHaveCount(0);
      await expect(page.locator('.ct-fab')).toHaveCount(0);
      await expect(page.locator('.ct-today__badge')).toHaveCount(0);
      await expect(page.locator('.ct-today__rule')).toHaveCount(0);

      // Colonne du jour bornée : 660 px ; agenda avec le dû en gros et la ligne « maintenant ».
      const column = page.locator('.ct-today__dayColumn');
      const box = await column.boundingBox();
      expect(box && Math.abs(box.width - 660) < 2).toBeTruthy();
      await expect(column.getByRole('heading', { level: 1 })).toHaveText(/mercredi 23/);
      await expect(column.locator('.ct-agenda__now')).toHaveText(/14:32/);
      const due = column.locator('.ct-agenda__line[data-phase="due"]').filter({ hasText: 'Relire le contrat' });
      await expect(due).toBeVisible();
      await expect(due).toContainText(/En retard de 3 h 32/);
      await expect(column.locator('.ct-agenda__line[data-phase="upcoming"]').filter({ hasText: 'Sport' }).locator('.ct-agenda__hour')).toHaveText('18:00');
      await expect(column.getByLabel('Nouvelle tâche')).toBeVisible();
      await expect(column.getByRole('button', { name: /^Scan/ })).toBeVisible();

      // Seconde colonne : demain, cette semaine, raccourcis.
      const side = page.locator('.ct-today__side');
      await expect(side.getByRole('heading', { name: 'Demain' })).toBeVisible();
      await expect(side.locator('.ct-today-side__row').filter({ hasText: 'Réunion d’équipe' })).toContainText('11:00');
      await expect(side.locator('.ct-today-side__row').filter({ hasText: 'Clôture mensuelle' })).toContainText('—');
      await expect(side.getByRole('heading', { name: 'Cette semaine' })).toBeVisible();
      await expect(side.locator('.ct-today-side__row').filter({ hasText: 'Point Capgemini' })).toContainText('ven.');
      await expect(side.getByRole('heading', { name: 'Raccourcis' })).toBeVisible();
      const sideBox = await side.boundingBox();
      expect(sideBox && sideBox.width <= 421 && sideBox.x > (box?.x ?? 0) + 660).toBeTruthy();
    });
  }

  test('les bascules nommées commandent le mode édition et la vue compacte ; « Ajouter » met le focus dans le champ (critère 1)', async ({ page }) => {
    await openToday(page);
    await createTask(page, test.info(), { title: 'À sélectionner' });
    const bar = page.locator('.ct-today__topbar');
    await bar.getByRole('button', { name: 'Mode édition' }).click();
    await expect(page.getByRole('button', { name: 'Sélectionner : À sélectionner' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Mode édition' })).toHaveAttribute('aria-pressed', 'true');
    await bar.getByRole('button', { name: 'Mode édition' }).click();
    await bar.getByRole('button', { name: 'Vue compacte' }).click();
    await expect(page.locator('.ct-list-row[data-compact="true"]').first()).toBeVisible();
    await bar.getByRole('button', { name: 'Vue compacte' }).click();
    await bar.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByLabel('Nouvelle tâche')).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toHaveCount(0);
  });
});
