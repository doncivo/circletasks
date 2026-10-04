import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, isPhone, rowOf } from './helpers/today';
import { setWheels } from './helpers/schedule';

/**
 * N-02 — Je choisis une avance (0, 5, 15, 30, 60 min, 1 jour).
 *
 * Couverture : bloc Rappel de la feuille d'ajout (iPhone) grisé sans heure, « À l'heure » cochée d'office avec une heure, « Plus… » et
 * les six avances ; puces triées de la fiche détail ; édition sur place (PC) et via « Modifier » (iPhone). Les lignes `reminder`
 * elles-mêmes sont vérifiées en Vitest. Aucune notification n'est émise. Exécuté sur `pc` et `iphone`.
 */
test.describe('N-02 — avances de rappel', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  async function createTimed(page: Page, testInfo: { project: { name: string } }): Promise<void> {
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
      await dialog.getByLabel('Titre').fill('Appeler le notaire');
      const atTime = dialog.getByRole('checkbox', { name: 'À l’heure' });
      await expect(atTime).toHaveAttribute('aria-disabled', 'true');
      await expect(atTime).toHaveAttribute('aria-checked', 'false');
      await setWheels(page, dialog, { time: '09:00' });
      await expect(atTime).toHaveAttribute('aria-disabled', 'false');
      await expect(atTime).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('checkbox', { name: '30 min' }).click();
      await dialog.getByRole('button', { name: 'Plus…' }).click();
      await expect(dialog.getByRole('checkbox')).toHaveCount(6);
      await dialog.getByRole('checkbox', { name: '1 jour' }).click();
      await dialog.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(dialog).not.toBeVisible();
    } else {
      // Saisie en ligne avec une heure : « À l'heure » est cochée d'office (QB-08).
      await createTask(page, testInfo, { title: 'Appeler le notaire', time: '09:00' });
    }
    await rowOf(page, 'Appeler le notaire').getByRole('button', { name: 'Appeler le notaire', exact: true }).click();
  }

  test('le détail affiche les puces triées ; l’édition ajoute et retire des rappels (critères 2, 3, 4)', async ({ page }, testInfo) => {
    await createTimed(page, testInfo);
    if (isPhone(testInfo)) {
      const detail = page.getByRole('dialog', { name: 'Détail de la tâche' });
      await expect(detail.locator('.ct-task-detail__chip')).toHaveText(['À l’heure', '30 min avant', '1 jour avant']);
      await detail.getByRole('button', { name: 'Modifier' }).click();
      const edit = page.getByRole('dialog', { name: 'Modifier la tâche' });
      await edit.getByRole('checkbox', { name: '1 jour' }).click();
      await edit.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(detail.locator('.ct-task-detail__chip')).toHaveText(['À l’heure', '30 min avant']);
      return;
    }
    const panel = page.getByRole('complementary', { name: 'Détail de la tâche' });
    await panel.getByRole('button', { name: 'Modifier les rappels' }).click();
    const group = panel.getByRole('group', { name: 'Rappels' });
    await group.getByRole('checkbox', { name: '30 min' }).click();
    await group.getByRole('button', { name: 'Plus…' }).click();
    await group.getByRole('checkbox', { name: '15 min' }).click();
    await group.getByRole('button', { name: 'Terminé' }).click();
    await expect(panel.locator('.ct-task-detail__chip')).toHaveText(['À l’heure', '15 min avant', '30 min avant']);
  });

  test('sans heure, le bloc Rappel est grisé (critère 7)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Bloc Rappel de la feuille d’ajout : iPhone ; sur PC, la fiche n’édite pas les rappels sans heure.');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    for (const name of ['À l’heure', '30 min', '1 heure']) {
      await expect(dialog.getByRole('checkbox', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });
});
