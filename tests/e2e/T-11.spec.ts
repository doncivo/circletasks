import { expect, test, type Page } from '@playwright/test';

/**
 * T-11 — Mes heures restent justes quand je change de pays.
 *
 * Fuseau simulé de deux façons : `timezoneId` Playwright (fuseau du navigateur au chargement)
 * et, pour un changement pendant que l'app est ouverte, un script d'initialisation qui fait
 * suivre `Intl.DateTimeFormat().resolvedOptions().timeZone` à `window.__ctZone`
 * (la détection de l'app passe par cette API). Le retour au premier plan est simulé par
 * l'événement `focus`.
 * Couverture : ligne « Fuseau horaire » (5), détection au retour au premier plan (6),
 * tâche à 10:00 inchangée après changement de fuseau (1), « Aujourd'hui » suit la date
 * locale du fuseau (8). Conversion UTC, journée entière, DST et routines : tests unitaires.
 * Exécuté sur `pc` et `iphone`.
 */

type Info = { project: { name: string } };

async function installZoneSwitch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function patched(this: Intl.DateTimeFormat) {
      const options = original.call(this);
      const zone = (window as unknown as { __ctZone?: string }).__ctZone;
      return zone ? { ...options, timeZone: zone } : options;
    };
  });
}

async function createTimedTask(page: Page, testInfo: Info, title: string, time: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByLabel('Heure').fill(time);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(title);
  await page.getByLabel('Heure').fill(time);
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

test.describe('T-11 — heures flottantes et fuseau', () => {
  test('Réglages affiche le fuseau courant suivi de « (automatique) » (critère 5)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    await openSettings(page);
    await expect(page.getByText('Fuseau horaire', { exact: true })).toBeVisible();
    await expect(page.getByText('Europe/Paris (automatique)')).toBeVisible();
  });

  test.describe('appareil à Tunis', () => {
    test.use({ timezoneId: 'Africa/Tunis' });
    test('le fuseau du système est repris au démarrage (critère 6)', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('navigation')).toBeVisible();
      await openSettings(page);
      await expect(page.getByText('Africa/Tunis (automatique)')).toBeVisible();
    });
  });

  test('changer de fuseau : détecté au retour au premier plan, la tâche à 10:00 reste à 10:00 (critères 1, 6)', async ({ page }, testInfo) => {
    await installZoneSwitch(page);
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    const title = `Réunion ${testInfo.project.name}`;
    await createTimedTask(page, testInfo, title, '10:00');
    const row = page.locator('.ct-list-row', { hasText: title });
    await expect(row).toContainText('10:00');

    await page.evaluate(() => {
      (window as unknown as { __ctZone: string }).__ctZone = 'Africa/Tunis';
      window.dispatchEvent(new Event('focus'));
    });

    await openSettings(page);
    await expect(page.getByText('Africa/Tunis (automatique)')).toBeVisible();
    await openTasks(page);
    await expect(row).toContainText('10:00');
    await expect(page.locator('.ct-list-row', { hasText: title })).toHaveCount(1);
  });

  test('« Aujourd’hui » suit la date locale de l’appareil (critère 8)', async ({ page }) => {
    // 23 sept. 2026 à 23:30 UTC : déjà le 24 à Paris (UTC+2).
    await page.clock.install({ time: new Date('2026-09-23T23:30:00Z') });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('24');
  });
});
