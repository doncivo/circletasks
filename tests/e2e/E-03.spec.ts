import { expect, test, type Page } from '@playwright/test';
import { lunarTableDate } from '../../src/domain/holidays';
import { openApp } from './helpers/app';
import { eventRow, openEvents } from './helpers/events';
import { addIsoDays, browserToday } from './helpers/schedule';
import { isPhone } from './helpers/today';
import { dayOf, openWeek } from './helpers/week';

/**
 * E-03 — J'affiche les jours fériés.
 *
 * Couverture : fériés France et Tunisie dans la liste Événements (tags « Férié FR » / « Férié TN », sous-lignes, « date estimée ») ;
 * Réglages › Jours fériés : deux interrupteurs séparés, état conservé ; bandeaux d'Aujourd'hui et de la Semaine le jour du férié ;
 * fiche d'une fête religieuse : « Modifier la date » (saisie manuelle prioritaire, plus « estimée »), « Rétablir la date de la table » ;
 * fête fixe en lecture seule ; année hors table : message dédié. Exécuté sur `pc` et `iphone`.
 */
const settingsTab = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Réglages', exact: true });

async function openHolidaySettings(page: Page): Promise<void> {
  await settingsTab(page).click();
  await page.getByRole('button', { name: /^Jours fériés :/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Jours fériés' })).toBeVisible();
}

test.describe('E-03 — jours fériés', () => {
  test('liste de l’année : fériés FR et TN avec leurs tags, fêtes religieuses « date estimée » (critères 1, 2, 4, 7)', async ({ page }) => {
    await openApp(page);
    await openEvents(page);
    const evacuation = eventRow(page, 'Fête de l’Évacuation');
    await expect(evacuation).toContainText('Jour férié · Tunisie');
    await expect(evacuation).toContainText('Férié TN');
    const toussaint = eventRow(page, 'Toussaint');
    await expect(toussaint).toContainText('Jour férié · France');
    await expect(toussaint).toContainText('Férié FR');
    await expect(eventRow(page, 'Aïd el-Fitr')).toContainText('Jour férié · Tunisie · date estimée');
    await expect(eventRow(page, 'Lundi de Pâques')).toContainText('Férié FR');
    // Sous Pro comme sous Perso : un férié n'a pas d'espace (critère 7).
    await page.getByRole('button', { name: 'Perso', exact: true }).first().click();
    await expect(eventRow(page, 'Toussaint')).toBeVisible();
    await page.getByRole('button', { name: 'Pro', exact: true }).first().click();
    await expect(eventRow(page, 'Fête de l’Évacuation')).toBeVisible();
  });

  test('Réglages › Jours fériés : deux interrupteurs, chaque pays séparément, état conservé (critères 3, 4, 9)', async ({ page }) => {
    await openApp(page);
    await settingsTab(page).click();
    await expect(page.getByRole('button', { name: 'Jours fériés : France, Tunisie' })).toBeVisible();
    await openHolidaySettings(page);
    const france = page.getByRole('switch', { name: 'Jours fériés de la France' });
    const tunisia = page.getByRole('switch', { name: 'Jours fériés de la Tunisie' });
    await expect(france).toBeChecked();
    await expect(tunisia).toBeChecked();
    await france.click();
    await expect(france).not.toBeChecked();
    await expect(tunisia).toBeChecked();
    await openEvents(page);
    await expect(eventRow(page, 'Toussaint')).toHaveCount(0);
    await expect(eventRow(page, 'Fête de l’Évacuation')).toBeVisible();
    await settingsTab(page).click();
    // Réglages se rouvre sur l'écran Jours fériés (dernier écran de l'onglet) ; « Retour » ramène à la liste des réglages.
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('button', { name: 'Jours fériés : Tunisie' })).toBeVisible();
    await openHolidaySettings(page);
    await expect(page.getByRole('switch', { name: 'Jours fériés de la France' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Jours fériés de la France' }).click();
    await page.getByRole('switch', { name: 'Jours fériés de la Tunisie' }).click();
    await openEvents(page);
    await expect(eventRow(page, 'Toussaint')).toBeVisible();
    await expect(eventRow(page, 'Fête de l’Évacuation')).toHaveCount(0);
  });

  test('bandeaux d’Aujourd’hui et de la Semaine le jour d’un férié, en lecture seule (critère 7, D5)', async ({ page }) => {
    // 1er novembre 2026 : Toussaint (France).
    await page.clock.setFixedTime(new Date('2026-11-01T10:00:00+01:00'));
    await openApp(page);
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Tâches', exact: true }).click();
    const band = page.getByRole('list', { name: 'Événements du jour' }).locator('li').filter({ hasText: 'Toussaint' });
    await expect(band).toContainText('Férié FR');
    await expect(band.getByRole('button')).toHaveCount(0);
    await openWeek(page);
    await expect(dayOf(page, '2026-11-01')).toContainText('Toussaint');
    await expect(dayOf(page, '2026-11-01').getByRole('button', { name: /Toussaint/ })).toHaveCount(0);
  });

  test('fiche d’une fête religieuse : modifier la date, rétablir la date de la table (critère 5)', async ({ page }, testInfo) => {
    // Jour figé au 10 mai 2027 : l'Aïd el-Idha de la table (16 mai) est à une semaine, à portée des roues de l'iPhone.
    await page.clock.setFixedTime(new Date('2027-05-10T10:00:00+02:00'));
    await openApp(page);
    const tableDate = lunarTableDate(2027, 'eidAlAdha');
    if (!tableDate) throw new Error('table des fêtes religieuses non couverte pour 2027');
    const official = addIsoDays(tableDate, 1);
    await openEvents(page);
    await expect(page.getByText('2027', { exact: true })).toBeVisible();
    await eventRow(page, 'Aïd el-Idha').click();
    const fiche = page.getByRole('dialog', { name: 'Jour férié' }).or(page.getByRole('complementary', { name: 'Jour férié' }));
    await expect(fiche.getByRole('heading', { name: 'Aïd el-Idha' })).toBeVisible();
    await expect(fiche).toContainText('Date estimée');
    await fiche.getByRole('button', { name: 'Modifier la date' }).click();
    const dialog = page.getByRole('dialog', { name: 'Date officielle' });
    if (isPhone(testInfo)) {
      // La roue des jours part de la date de la table (16 mai) : un cran en avant donne le 17 mai.
      await dialog.getByRole('spinbutton', { name: 'Jour' }).focus();
      await page.keyboard.press('ArrowUp');
    } else {
      const [y, m, d] = official.split('-');
      await dialog.getByRole('textbox', { name: 'Date' }).fill(`${d ?? ''}/${m ?? ''}/${y ?? ''}`);
    }
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).toBeHidden();
    await expect(fiche).toContainText('Date saisie à la main');
    await expect(eventRow(page, 'Aïd el-Idha')).toHaveAttribute('data-date', official);
    await expect(eventRow(page, 'Aïd el-Idha')).not.toContainText('date estimée');
    await fiche.getByRole('button', { name: 'Rétablir la date de la table' }).click();
    await expect(fiche).toContainText('Date estimée');
    await expect(eventRow(page, 'Aïd el-Idha')).toHaveAttribute('data-date', tableDate);
    await expect(eventRow(page, 'Aïd el-Idha')).toContainText('date estimée');
  });

  test('une fête fixe est en lecture seule (critère 5)', async ({ page }) => {
    await openApp(page);
    await openEvents(page);
    await eventRow(page, 'Fête de l’Évacuation').click();
    const fiche = page.getByRole('dialog', { name: 'Jour férié' }).or(page.getByRole('complementary', { name: 'Jour férié' }));
    await expect(fiche.getByRole('heading', { name: 'Fête de l’Évacuation' })).toBeVisible();
    await expect(fiche).toContainText('Date fixe : elle ne se modifie pas.');
    await expect(fiche.getByRole('button', { name: 'Modifier la date' })).toHaveCount(0);
  });

  test('année hors table : fêtes fixes et calculées, message « Dates religieuses non disponibles » (critère 8)', async ({ page }) => {
    await openApp(page);
    const year = Number((await browserToday(page)).slice(0, 4));
    await openEvents(page);
    for (let i = year; i < 2031; i += 1) await page.getByRole('button', { name: 'Année suivante' }).click();
    await expect(page.getByText('Dates religieuses non disponibles pour 2031')).toBeVisible();
    await expect(eventRow(page, 'Toussaint')).toBeVisible();
    await expect(eventRow(page, 'Fête de l’Évacuation')).toBeVisible();
    await expect(eventRow(page, 'Aïd el-Fitr')).toHaveCount(0);
  });
});
