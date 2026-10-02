import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, reopenRoutines, routineForm, setRoutineTime } from './helpers/routines';
import { browserToday } from './helpers/schedule';
import { isPhone, listTitles, todayTab } from './helpers/today';
import { insertTasks } from './helpers/week';

/**
 * R-02 — J'associe une heure optionnelle.
 *
 * Couverture : sélecteur d'heure (roues iPhone, champ HH:MM PC, effacement) ; routine triée parmi les tâches par son heure, sans heure
 * après les éléments horodatés ; cases de rappel grisées sans heure (QB-07), « À l'heure » cochée d'office (QB-08) ; heure 24 h ; aucune
 * notification émise sur le PC. Les rappels eux-mêmes (table `reminder`) sont vérifiés en Testing Library : le navigateur de
 * développement n'expose pas de lecture de rappels. Exécuté sur `pc` et `iphone`.
 */
test.describe('R-02 — heure optionnelle d’une routine', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  async function openCreate(page: Page, testInfo: { project: { name: string } }) {
    await openRoutines(page);
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    const form = routineForm(page, 'Nouvelle routine');
    await form.getByLabel('Nom de la routine').fill('Lire 20 minutes');
    return form;
  }

  test('sans heure, les cases de rappel sont grisées ; avec une heure elles deviennent actives, « À l’heure » cochée (critères 1, 5)', async ({ page }, testInfo) => {
    const form = await openCreate(page, testInfo);
    const atTime = form.getByRole('checkbox', { name: 'À l’heure' });
    const thirty = form.getByRole('checkbox', { name: '30 min' });
    await expect(atTime).toHaveAttribute('aria-disabled', 'true');
    await expect(thirty).toHaveAttribute('aria-disabled', 'true');
    await atTime.click({ force: true });
    await expect(atTime).toHaveAttribute('aria-checked', 'false');

    await setRoutineTime(page, form, testInfo, '07:30');
    await expect(form.getByRole('button', { name: 'Heure de la routine : 07:30' })).toBeVisible();
    await expect(atTime).toHaveAttribute('aria-disabled', 'false');
    await expect(atTime).toHaveAttribute('aria-checked', 'true');
    await thirty.click();
    await expect(thirty).toHaveAttribute('aria-checked', 'true');

    await setRoutineTime(page, form, testInfo, null);
    await expect(atTime).toHaveAttribute('aria-disabled', 'true');
    await expect(atTime).toHaveAttribute('aria-checked', 'false');
    await expect(thirty).toHaveAttribute('aria-checked', 'false');
  });

  test('l’heure s’affiche sur 24 h dans la carte, « 07:30 » jamais « 7:30 » (critère 8)', async ({ page }, testInfo) => {
    const form = await openCreate(page, testInfo);
    await setRoutineTime(page, form, testInfo, '07:30');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    const card = cardOf(page, 'Lire 20 minutes');
    await expect(card).toContainText('07:30 · Pro');
    await expect(card).not.toContainText(/(^|\s)7:30/);
  });

  test('Aujourd’hui : routine à 08:30 entre les tâches de 08:00 et 09:00 ; routine sans heure après les éléments horodatés (critères 2, 3)', async ({ page }) => {
    const today = await browserToday(page);
    await insertTasks(page, [
      { title: 'Réunion', date: today, time: '08:00' },
      { title: 'Appeler le notaire', date: today, time: '09:00' },
      { title: 'Courses', date: today },
    ]);
    await insertRoutines(page, [{ title: 'Boire de l’eau', time: '08:30' }, { title: 'Ranger le bureau' }]);
    await reopenRoutines(page);
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Ranger le bureau' })).toBeVisible();
    const titles = await listTitles(page);
    expect(titles.slice(0, 3)).toEqual(['Réunion', 'Boire de l’eau', 'Appeler le notaire']);
    expect(titles.indexOf('Ranger le bureau')).toBeGreaterThan(titles.indexOf('Appeler le notaire'));
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Boire de l’eau' })).toContainText('08:30 · Routine');
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Ranger le bureau' })).not.toContainText(/\d\d:\d\d/);
  });

  test('aucune notification n’est émise ni demandée (critère 7)', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const calls: string[] = [];
      (window as unknown as { __notifications: string[] }).__notifications = calls;
      const FakeNotification = Object.assign(
        function FakeNotification() {
          calls.push('new');
        },
        {
          permission: 'default',
          requestPermission: (): Promise<string> => {
            calls.push('permission');
            return Promise.resolve('denied');
          },
        },
      );
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    });
    await openApp(page);
    const form = await openCreate(page, testInfo);
    await setRoutineTime(page, form, testInfo, '07:30');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __notifications: string[] }).__notifications)).toEqual([]);
  });

  test('effacer l’heure d’une routine existante la rend sans heure', async ({ page }, testInfo) => {
    await insertRoutines(page, [{ title: 'Sport', time: '18:00' }]);
    await reopenRoutines(page);
    await cardOf(page, 'Sport').getByRole('button', { name: 'Éditer la routine Sport' }).click();
    const form = routineForm(page, 'Modifier la routine');
    await expect(form.getByRole('button', { name: 'Heure de la routine : 18:00' })).toBeVisible();
    await setRoutineTime(page, form, testInfo, null);
    await expect(form.getByRole('button', { name: 'Heure de la routine : aucune' })).toBeVisible();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    await expect(cardOf(page, 'Sport')).not.toContainText('18:00');
  });
});
