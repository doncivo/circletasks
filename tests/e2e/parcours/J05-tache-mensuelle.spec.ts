import { expect, test, type Page } from '@playwright/test';
import { openApp } from '../helpers/app';
import { isPhone } from '../helpers/today';

/**
 * Parcours clé 5 (PRD 8) : tâche mensuelle récurrente (T-09), terminée, puis l'occurrence suivante un mois plus tard (T-10).
 * Horloge Playwright : mercredi 23 sept. 2026 à 09:00. iPhone : feuille « Nouvelle tâche » ; PC : « Rendre la tâche récurrente » de la fiche.
 */
const DAY_MS = 24 * 60 * 60_000;

async function advanceDays(page: Page, days: number): Promise<void> {
  for (let left = days; left > 0; left -= 10) {
    await page.clock.fastForward(Math.min(left, 10) * DAY_MS);
    await page.waitForTimeout(300);
  }
}

test('parcours 5 : créer une tâche mensuelle, la terminer, vérifier l’occurrence suivante', async ({ page }, testInfo) => {
  const title = `Envoyer la facture ${testInfo.project.name}`;
  await page.clock.install({ time: new Date('2026-09-23T09:00:00+02:00') });
  await openApp(page);

  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByRole('radio', { name: 'Mensuel' }).click();
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
  } else {
    const field = page.getByLabel('Nouvelle tâche');
    await field.fill(title);
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await page.getByRole('button', { name: title }).click();
    const detail = page.getByLabel('Détail de la tâche');
    await detail.getByRole('button', { name: 'Rendre la tâche récurrente' }).click();
    await detail.getByRole('radio', { name: 'Mensuel' }).click();
    await detail.getByRole('button', { name: 'Valider' }).click();
    await detail.getByRole('button', { name: 'Fermer' }).first().click();
    await expect(detail).not.toBeVisible();
  }

  await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
  await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();

  await advanceDays(page, 30);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
  await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toHaveCount(0);
  await page.getByRole('button', { name: title }).click();
  await expect(page.getByLabel('Détail de la tâche').getByText('Mensuelle, le 23')).toBeVisible();
});
