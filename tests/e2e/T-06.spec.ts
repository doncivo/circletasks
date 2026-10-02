import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-06 — Les tâches non faites passent au lendemain.
 *
 * Horloge Playwright : on installe le 23 sept. 2026 à 23:50 (Europe/Paris), on crée une
 * tâche datée du 23, puis on avance l'horloge au-delà de minuit avec l'app ouverte.
 * Couverture : interrupteur activé par défaut (critère 11), report à 00:00 avec badge
 * « reportée » dans Aujourd'hui (critères 1, 3), badge effacé en terminant la tâche
 * (critère 4), option désactivée : rien ne bouge et rien dans Aujourd'hui (critères 5, 8).
 * Les cas limites (jours sautés, exclusions, DST, récurrence) sont couverts en tests
 * unitaires et d'intégration. Exécuté sur `pc` et `iphone`.
 */

type Info = { project: { name: string } };

const BEFORE_MIDNIGHT = new Date('2026-09-23T23:50:00+02:00');
const AFTER_MIDNIGHT_MS = 20 * 60_000;

async function createTask(page: Page, testInfo: Info, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(title);
  await field.press('Enter');
  await expect(field).toHaveValue('');
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

async function openTasks(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Tâches', { exact: true }).click();
}

test.describe('T-06 — report automatique à minuit', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: BEFORE_MIDNIGHT });
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('l’interrupteur est activé par défaut (critère 11)', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('TÂCHES', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Reporter les tâches non faites' })).toHaveAttribute('aria-checked', 'true');
  });

  test('à minuit la tâche non faite passe au 24 avec le badge « reportée », terminer l’efface (critères 1, 3, 4)', async ({ page }, testInfo) => {
    const title = `Rapport ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await expect(page.getByRole('button', { name: title })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByText('reportée')).toHaveCount(0);

    await page.clock.fastForward(AFTER_MIDNIGHT_MS);

    // Le jour affiché est passé au 24 et la tâche (datée du 23) y figure avec le badge.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('24');
    const row = page.getByRole('button', { name: title });
    await expect(row).toBeVisible();
    await expect(page.getByText('reportée')).toBeVisible();

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await expect(page.getByText('reportée')).toHaveCount(0);
    // Le report automatique n'est jamais proposé à l'annulation (critère 10) : seul « terminée » l'est.
    await expect(page.getByText('reportée à')).toHaveCount(0);
  });

  test('option désactivée : la tâche reste au 23, absente d’Aujourd’hui le 24, sans section « En retard » (critères 5, 8)', async ({ page }, testInfo) => {
    const title = `Reste ${testInfo.project.name}`;
    await openSettings(page);
    const toggle = page.getByRole('switch', { name: 'Reporter les tâches non faites' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await openTasks(page);
    await createTask(page, testInfo, title);
    await expect(page.getByRole('button', { name: title })).toBeVisible();

    await page.clock.fastForward(AFTER_MIDNIGHT_MS);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('24');
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await expect(page.getByText('reportée')).toHaveCount(0);
    await expect(page.getByText(/en retard/i)).toHaveCount(0);
  });
});
