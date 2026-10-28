import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { dayOf, dayTitles, insertTasks, openWeek } from './helpers/week';

/**
 * UI-REFONTE-03 — Semaine sur iPhone (docs/maquettes-refonte/Semaine-v2.html) : en-tête « semaine 39 », synthèse, aujourd'hui au trait
 * d'encre, colonne d'heures, sélection d'un jour et rangée d'ajout unique, thème sombre, zone de sécurité. Projets `iphone` (Chromium)
 * et `iphone-webkit`. Le PC est couvert par S-01 à S-06, inchangés. Horloge figée au mercredi 23 sept. 2026, 14:32 (semaine ISO 39).
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

const WEEK = [
  { title: 'Faire mon lit', date: '2026-09-21', done: true },
  { title: 'Relire le contrat', date: '2026-09-21', done: true },
  { title: 'Appeler la banque', date: '2026-09-22', time: '11:00', done: true },
  { title: 'Oubliée mardi', date: '2026-09-22' },
  { title: 'Envoyer la facture', date: '2026-09-23', time: '09:00', done: true },
  { title: 'Appeler le notaire', date: '2026-09-23', time: '14:00' },
  { title: 'Sport', date: '2026-09-23', time: '18:00' },
  { title: 'Réunion d’équipe', date: '2026-09-24', time: '11:00' },
  { title: 'Préparer le dépôt GitHub', date: '2026-09-24' },
  { title: 'Clôture mensuelle', date: '2026-09-25', space: 'perso' as const },
  { title: 'Courses', date: '2026-09-26', space: 'perso' as const },
] as const;

async function openFixedWeek(page: Page, scheme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.clock.setFixedTime(new Date('2026-09-23T14:32:00+02:00'));
  await openApp(page);
  await insertTasks(page, WEEK);
  await openWeek(page);
}

const addField = (page: Page) => page.locator('.ct-week__addRow').getByRole('combobox', { name: 'Nouvelle tâche' });

test.describe('UI-REFONTE-03 — Semaine sur iPhone', () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), 'Mise en page iPhone seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : en-tête, synthèse, aujourd'hui au trait sans fond, colonne d'heures, retard (critères 1, 2, 4, 5, 9)`, async ({ page }) => {
      await openFixedWeek(page, scheme);
      await expect(page.locator('.ct-week__caption')).toHaveText('semaine 39');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('21 – 27 sept.');
      await expect(page.locator('.ct-week__rule')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cette semaine' })).toHaveCount(0);
      await expect(page.locator('.ct-week__summary')).toHaveText('7 tâches restantes · 4 faites · 2 en retard');

      // Jours en minuscules ; aujourd'hui : trait d'encre de 2 px en haut, fond transparent ; week-end gris.
      await expect(dayOf(page, '2026-09-21').locator('.ct-week-day__weekday')).toHaveText('lun.');
      const today = dayOf(page, '2026-09-23');
      await expect(today).toHaveAttribute('aria-current', 'date');
      const todayStyle = await today.evaluate((node) => {
        const style = getComputedStyle(node);
        return { border: style.borderTopWidth, background: style.backgroundColor };
      });
      expect(parseFloat(todayStyle.border)).toBeGreaterThanOrEqual(2);
      expect(todayStyle.background).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      const weekendColor = await dayOf(page, '2026-09-26').locator('.ct-week-day__weekday').evaluate((node) => getComputedStyle(node).color);
      const todayColor = await today.locator('.ct-week-day__weekday').evaluate((node) => getComputedStyle(node).color);
      expect(weekendColor).not.toBe(todayColor);

      // Colonne d'heures : heure ou tiret ; la faite reste à son heure ; la due porte « en retard ».
      expect(await dayTitles(page, '2026-09-23')).toEqual(['Envoyer la facture', 'Appeler le notaire', 'Sport']);
      await expect(today.locator('.ct-week-item__time')).toHaveText(['09:00', '14:00', '18:00']);
      const late = today.locator('.ct-week-item').filter({ hasText: 'Appeler le notaire' });
      await expect(late).toHaveAttribute('data-late', 'true');
      await expect(late.locator('.ct-week-item__late')).toHaveText('en retard');
      await expect(dayOf(page, '2026-09-24').locator('.ct-week-item__time')).toHaveText(['11:00', '—']);
      await expect(dayOf(page, '2026-09-27').locator('.ct-week-day__empty')).toHaveText('Rien de prévu');
      // Plus de bouton « + Ajouter » par section.
      await expect(page.locator('.ct-week__days').getByRole('button', { name: /^Ajouter une tâche,/ })).toHaveCount(0);
    });
  }

  test('ajout : la rangée vise aujourd’hui, un toucher sur un jour la fait viser ce jour, Entrée crée dans ce jour, « + » ouvre la feuille (critère 7)', async ({ page }) => {
    await openFixedWeek(page);
    await expect(addField(page)).toHaveAttribute('placeholder', 'Ajouter à mercredi 23');
    await dayOf(page, '2026-09-24').getByRole('button', { name: /^Choisir / }).click();
    await expect(addField(page)).toHaveAttribute('placeholder', 'Ajouter à jeudi 24');
    await expect(dayOf(page, '2026-09-24').getByRole('button', { name: /^Choisir / })).toHaveAttribute('aria-pressed', 'true');
    await addField(page).fill('Point hebdo');
    await addField(page).press('Enter');
    // Sans heure : après la ligne à l'heure, dans l'ordre manuel (la nouvelle en dernier).
    await expect.poll(() => dayTitles(page, '2026-09-24')).toEqual(['Réunion d’équipe', 'Préparer le dépôt GitHub', 'Point hebdo']);
    await expect(addField(page)).toHaveValue('');
    await expect(page.locator('.ct-week__summary')).toHaveText('8 tâches restantes · 4 faites · 2 en retard');

    await page.locator('.ct-week__addRow').getByRole('button', { name: 'Ajouter', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(sheet).toBeVisible();
  });

  test('zone de sécurité : l’en-tête commence sous la marge haute, la rangée d’ajout finit au-dessus de la marge basse et tient dans la largeur (critère 10)', async ({ page }) => {
    await openFixedWeek(page);
    const title = await page.locator('main h1.ct-week__range').boundingBox();
    const add = await page.locator('.ct-week__addRow').boundingBox();
    const viewport = page.viewportSize();
    expect(title && title.y >= 44).toBeTruthy();
    // La zone de sécurité du navigateur est nulle : la rangée tient dans l'écran et dans sa largeur ; la marge iOS vient de `--ct-safe-area-bottom`.
    expect(add && viewport && add.y + add.height <= viewport.height).toBeTruthy();
    expect(add && viewport && add.x >= 0 && add.x + add.width <= viewport.width).toBeTruthy();
    await expect(addField(page)).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.ct-week__addRow').getByRole('button', { name: 'Ajouter', exact: true })).toBeInViewport({ ratio: 1 });
  });

  test('semaine vide : « Rien de prévu cette semaine » dans la synthèse, état vide conservé, rangée d’ajout présente (critères 2 et 6)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T14:32:00+02:00'));
    await openApp(page);
    await openWeek(page);
    await expect(page.locator('.ct-week__summary')).toHaveText('Rien de prévu cette semaine');
    await expect(page.locator('.ct-week__empty')).toBeVisible();
    await expect(addField(page)).toBeVisible();
  });
});
