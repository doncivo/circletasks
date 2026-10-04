import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { addEventButton, eventRow, insertEvents, openEvents, reopenEvents } from './helpers/events';
import { browserToday } from './helpers/schedule';
import { isPhone } from './helpers/today';

/**
 * E-02 — Je crée un anniversaire ou une date importante.
 *
 * Couverture : type « Anniversaire » / « Date importante » (répétition Annuel imposée, icône par défaut, rappels « La veille » et « Le
 * jour même » cochés) ; année de naissance facultative (roue « Sans année » sur iPhone, champ sur PC) ; « Annuel · N ans » seulement si
 * l'année est renseignée ; année future refusée (PC) ; l'événement revient chaque année ; changement de type d'un événement existant.
 * Exécuté sur `pc` et `iphone`.
 */
async function press(page: Page, wheel: Locator, key: string, times: number): Promise<void> {
  await wheel.focus();
  for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
}

/** Choisit le 25 septembre et l'année de naissance (iPhone : roues ; PC : champ date et champ année). */
async function pickBirth(page: Page, sheet: Locator, testInfo: { project: { name: string } }, year: number | null): Promise<void> {
  if (isPhone(testInfo)) {
    const today = await browserToday(page);
    const [, month, day] = today.split('-').map(Number);
    await press(page, sheet.getByRole('spinbutton', { name: 'Mois' }), (month ?? 9) >= 9 ? 'ArrowDown' : 'ArrowUp', Math.abs((month ?? 9) - 9));
    await press(page, sheet.getByRole('spinbutton', { name: 'Jour' }), (day ?? 25) <= 25 ? 'ArrowUp' : 'ArrowDown', Math.abs(25 - (day ?? 25)));
    if (year !== null) await press(page, sheet.getByRole('spinbutton', { name: 'Année' }), 'ArrowUp', year - 1900 + 1);
    return;
  }
  const field = sheet.getByRole('combobox', { name: 'Date' });
  await field.fill('25/09');
  await field.press('Enter');
  if (year !== null) await sheet.getByLabel('Année de naissance (facultatif)').fill(String(year));
}

test.describe('E-02 — anniversaire et date importante', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('type « Anniversaire » : Annuel imposé, icône gâteau, rappels par défaut (critères 1, 6)', async ({ page }, testInfo) => {
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    await sheet.getByRole('radio', { name: 'Anniversaire' }).check();
    await expect(sheet.getByRole('radio', { name: 'Annuel' })).toBeChecked();
    await expect(sheet.getByRole('radio', { name: 'Annuel' })).toBeDisabled();
    await expect(sheet.getByRole('checkbox', { name: /Journée entière/ })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: /Icône gâteau/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByRole('checkbox', { name: 'La veille' })).toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: 'Le jour même' })).toBeChecked();
    await sheet.getByRole('radio', { name: 'Date importante' }).check();
    await expect(sheet.getByRole('button', { name: /Icône étoile/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('année 1992 : « Annuel · N ans » ; l’année suivante ajoute un an ; sans année : pas d’âge (critères 2, 3, 5)', async ({ page }, testInfo) => {
    const year = Number((await browserToday(page)).slice(0, 4));
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    await sheet.getByLabel('Titre', { exact: true }).fill('Anniversaire de Karim');
    await sheet.getByRole('radio', { name: 'Anniversaire' }).check();
    await pickBirth(page, sheet, testInfo, 1992);
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(sheet).toBeHidden();
    await expect(eventRow(page, 'Anniversaire de Karim')).toContainText(`Annuel · ${year - 1992} ans`);
    await page.getByRole('button', { name: 'Année suivante' }).click();
    await expect(eventRow(page, 'Anniversaire de Karim')).toContainText(`Annuel · ${year + 1 - 1992} ans`);

    await page.getByRole('button', { name: 'Année précédente' }).click();
    await addEventButton(page, testInfo).click();
    const second = page.getByRole('dialog', { name: 'Nouvel événement' });
    await second.getByLabel('Titre', { exact: true }).fill('Fête du club');
    await second.getByRole('radio', { name: 'Anniversaire' }).check();
    await pickBirth(page, second, testInfo, null);
    await second.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(second).toBeHidden();
    await expect(eventRow(page, 'Fête du club')).toContainText('Annuel');
    await expect(eventRow(page, 'Fête du club')).not.toContainText('ans');
  });

  test('PC : une année de naissance future est refusée (critère 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'La roue des années de l’iPhone s’arrête à l’année en cours.');
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    await sheet.getByLabel('Titre', { exact: true }).fill('Futur');
    await sheet.getByRole('radio', { name: 'Anniversaire' }).check();
    await sheet.getByLabel('Année de naissance (facultatif)').fill('2999');
    await expect(sheet.getByRole('alert')).toContainText('ne peut pas être dans le futur');
    await expect(sheet.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await sheet.getByLabel('Année de naissance (facultatif)').fill('');
    await expect(sheet.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  });

  test('un anniversaire existant revient chaque année ; changer son type garde titre, espace et icône (critères 5, 7)', async ({ page }) => {
    const year = Number((await browserToday(page)).slice(0, 4));
    await insertEvents(page, [{ title: 'Karim', date: '1992-03-10', kind: 'birthday', repeat: 'yearly', birthYear: 1992, space: 'perso', icon: 'lucide:heart' }]);
    await reopenEvents(page);
    for (let i = 0; i < 3; i += 1) {
      await expect(eventRow(page, 'Karim')).toContainText(`Annuel · ${year + i - 1992} ans`);
      await page.getByRole('button', { name: 'Année suivante' }).click();
    }
    await eventRow(page, 'Karim').click();
    const edit = page.getByRole('dialog', { name: 'Modifier l’événement' }).or(page.getByRole('complementary', { name: 'Modifier l’événement' }));
    await edit.getByRole('radio', { name: 'Date importante' }).check();
    await expect(edit.getByLabel('Titre', { exact: true })).toHaveValue('Karim');
    await expect(edit.getByRole('button', { name: 'Perso', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(edit.getByRole('button', { name: /Icône cœur/ })).toHaveAttribute('aria-pressed', 'true');
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(eventRow(page, 'Karim')).toContainText('Annuel');
  });
});
