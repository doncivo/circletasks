import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-14 — Je choisis une date adaptée à mon appareil.
 *
 * Horloge : mercredi 23 septembre 2026, 10:00 (Europe/Paris), comme PC-Date.html.
 * iPhone (440 x 956) : feuille « Nouvelle tâche » avec puces et trois roues (critères 1 à 5) ; les roues
 * se règlent au clavier (rôle spinbutton, critère 6). PC (1440 x 900) : champ « Date » à saisie libre,
 * bandeau « Compris : … », mini-calendrier, puces, champ « Heure » (critères 7 à 12) ; « Choisir une date »
 * du report (critère 13). L'analyse des phrases et le calendrier sont détaillés en tests unitaires.
 */

const NOW = new Date('2026-09-23T10:00:00+02:00');

type Info = { project: { name: string } };

async function open(page: Page): Promise<void> {
  await page.clock.install({ time: NOW });
  await openApp(page);
  await expect(page.getByRole('navigation')).toBeVisible();
}

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Nouvelle tâche' });

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Ajouter' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function press(page: Page, wheel: ReturnType<Page['locator']>, key: string, times: number): Promise<void> {
  await wheel.focus();
  for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
}

test.describe('T-14 — sélecteur de date par appareil', () => {
  test.describe('iPhone : puces et roues', () => {
    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'iphone', 'Roues propres à l’iPhone');
      await open(page);
    });

    test('la roue des jours part de « Aujourd’hui », la puce est active ; faire défiler met la puce à jour (critères 1, 2)', async ({ page }) => {
      const dialog = await openSheet(page);
      const days = dialog.getByRole('spinbutton', { name: 'Jour' });
      await expect(days).toHaveAttribute('aria-valuetext', 'Aujourd’hui');
      await expect(dialog.getByRole('button', { name: 'Aujourd’hui' })).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.getByText('Jeu. 24 sept.')).toBeVisible();

      await press(page, days, 'ArrowUp', 1);
      await expect(days).toHaveAttribute('aria-valuetext', 'Jeu. 24 sept.');
      await expect(dialog.getByRole('button', { name: 'Demain' })).toHaveAttribute('aria-pressed', 'true');
      await press(page, days, 'ArrowUp', 1);
      await expect(dialog.getByRole('button', { name: 'Aujourd’hui' })).toHaveAttribute('aria-pressed', 'false');
      await expect(dialog.getByRole('button', { name: 'Demain' })).toHaveAttribute('aria-pressed', 'false');
    });

    test('défilement tactile : la roue se cale et le choix suit (critère 2)', async ({ page }) => {
      const dialog = await openSheet(page);
      const days = dialog.getByRole('spinbutton', { name: 'Jour' });
      // Défilement natif de 3 lignes (32 px chacune) : la roue se cale sur « Dim. 27 sept. ».
      await days.locator('.ct-wheel__viewport').evaluate((el) => {
        el.scrollTop += 4 * 32;
      });
      await expect(days).toHaveAttribute('aria-valuetext', 'Dim. 27 sept.');
    });

    test('heures « — » par défaut, minutes grisées puis actives dès qu’une heure est choisie, par pas de 5 (critères 3, 4)', async ({ page }) => {
      const dialog = await openSheet(page);
      const hours = dialog.getByRole('spinbutton', { name: 'Heures' });
      const minutes = dialog.getByRole('spinbutton', { name: 'Minutes' });
      await expect(hours).toHaveAttribute('aria-valuetext', 'Sans heure');
      await expect(minutes).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByRole('switch')).toHaveCount(0); // pas d'interrupteur « Heure »

      await press(page, hours, 'ArrowUp', 11);
      await expect(hours).toHaveAttribute('aria-valuetext', '10 heures');
      await expect(minutes).not.toHaveAttribute('aria-disabled', 'true');
      await press(page, minutes, 'ArrowUp', 1);
      await expect(minutes).toHaveAttribute('aria-valuetext', '5 minutes');
      await expect(minutes).toHaveAttribute('aria-valuemax', '11');
      await expect(hours).toHaveAttribute('aria-valuemax', '24');

      await press(page, hours, 'Home', 1);
      await expect(hours).toHaveAttribute('aria-valuetext', 'Sans heure');
      await expect(minutes).toHaveAttribute('aria-disabled', 'true');
    });

    test('une tâche à 10:05 aujourd’hui affiche 10:05 ; sans heure, aucune heure (critères 3, 4)', async ({ page }) => {
      let dialog = await openSheet(page);
      await dialog.getByLabel('Titre').fill('Avec heure');
      await press(page, dialog.getByRole('spinbutton', { name: 'Heures' }), 'ArrowUp', 11);
      await press(page, dialog.getByRole('spinbutton', { name: 'Minutes' }), 'ArrowUp', 1);
      await dialog.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(page.locator('.ct-list-row', { hasText: 'Avec heure' })).toContainText('10:05');

      dialog = await openSheet(page);
      await dialog.getByLabel('Titre').fill('Sans heure');
      await dialog.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(page.locator('.ct-list-row', { hasText: 'Sans heure' })).not.toContainText(':');
    });

    test('« Demain » place la roue sur demain ; « Un jour » grise les roues et range la tâche hors d’Aujourd’hui (critère 5)', async ({ page }) => {
      const dialog = await openSheet(page);
      await dialog.getByRole('button', { name: 'Demain' }).click();
      await expect(dialog.getByRole('spinbutton', { name: 'Jour' })).toHaveAttribute('aria-valuetext', 'Jeu. 24 sept.');

      await dialog.getByRole('button', { name: 'Un jour' }).click();
      for (const name of ['Jour', 'Heures', 'Minutes']) await expect(dialog.getByRole('spinbutton', { name })).toHaveAttribute('aria-disabled', 'true');
      await dialog.getByLabel('Titre').fill('Un de ces jours');
      await dialog.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByText('Un de ces jours')).toHaveCount(0);

      // Même sélecteur pour « Choisir une date » du report (critère 13) : il propose les roues, pas de champ natif.
      await expect(page.locator('input[type="date"], input[type="time"]')).toHaveCount(0);
    });

    test('chaque roue est annoncée avec une valeur en français (critère 6)', async ({ page }) => {
      const dialog = await openSheet(page);
      for (const name of ['Jour', 'Heures', 'Minutes']) {
        const wheel = dialog.getByRole('spinbutton', { name });
        await expect(wheel).toHaveAttribute('aria-valuetext', /.+/);
        await expect(wheel).toHaveAttribute('aria-valuenow', /\d+/);
      }
      await press(page, dialog.getByRole('spinbutton', { name: 'Heures' }), 'ArrowUp', 2);
      await expect(dialog.getByRole('spinbutton', { name: 'Heures' })).toHaveAttribute('aria-valuetext', '1 heure');
    });
  });

  test.describe('PC : champ « Date », saisie libre et mini-calendrier', () => {
    test.beforeEach(async ({ page }, testInfo: Info) => {
      test.skip(testInfo.project.name !== 'pc', 'Champ « Date » propre au PC');
      await open(page);
    });

    const field = (page: Page) => page.getByRole('combobox', { name: 'Date' });
    const popover = (page: Page) => page.getByRole('dialog', { name: 'Choisir une date' });

    test('« ven 10h » : bandeau « Compris : vendredi 25 sept. à 10:00 » en direct (critère 7)', async ({ page }) => {
      await field(page).fill('ven 10h');
      await expect(popover(page)).toContainText('Compris : vendredi 25 sept. à 10:00');
      await field(page).fill('demain');
      await expect(popover(page)).toContainText('Compris : jeudi 24 sept.');
      await field(page).fill('lun. 10h');
      await expect(popover(page)).toContainText('Compris : lundi 28 sept. à 10:00');
      await field(page).fill('dans 3 jours');
      await expect(popover(page)).toContainText('Compris : samedi 26 sept.');
      await expect(popover(page)).toContainText('Entrée pour valider · Échap pour fermer');
    });

    test('Entrée valide et ferme ; Échap ferme sans changer ; saisie non comprise : « Date non comprise » (critères 7, 8)', async ({ page }) => {
      await field(page).fill('blabla');
      await expect(popover(page)).toContainText('Date non comprise');
      await field(page).press('Enter');
      await expect(popover(page)).toBeVisible(); // Entrée ne valide pas

      await field(page).fill('25/09 14:30');
      await field(page).press('Enter');
      await expect(popover(page)).toHaveCount(0);
      await expect(field(page)).toHaveValue('ven. 25 sept. 14:30');

      await field(page).fill('demain');
      await field(page).press('Escape');
      await expect(popover(page)).toHaveCount(0);
      await expect(field(page)).toHaveValue('ven. 25 sept. 14:30');
    });

    test('un clic sur un jour du calendrier le choisit ; mois précédent / suivant ; lundi en premier (critères 9, 12)', async ({ page }) => {
      await field(page).click();
      const pop = popover(page);
      await expect(pop.getByText('Septembre 2026')).toBeVisible();
      await expect(pop.locator('.ct-date-editor__weekday')).toHaveText(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
      await expect(pop.getByRole('button', { name: '23 septembre, aujourd’hui' })).toBeVisible();

      await pop.getByRole('button', { name: 'Mois suivant' }).click();
      await expect(pop.getByText('Octobre 2026')).toBeVisible();
      await pop.getByRole('button', { name: 'Mois précédent' }).click();
      await pop.getByRole('button', { name: 'Mois précédent' }).click();
      await expect(pop.getByText('Août 2026')).toBeVisible();
      await pop.getByRole('button', { name: 'Mois suivant' }).click();

      await pop.getByRole('button', { name: '25 septembre' }).click();
      await expect(popover(page)).toHaveCount(0);
      await expect(field(page)).toHaveValue('ven. 25 sept.');
    });

    test('flèches du clavier dans la grille, y compris au changement de mois (critère 9)', async ({ page }) => {
      await field(page).click();
      const pop = popover(page);
      await pop.getByRole('button', { name: '23 septembre, aujourd’hui' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(pop.getByRole('button', { name: '24 septembre' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(pop.getByText('Octobre 2026')).toBeVisible();
      await expect(pop.getByRole('button', { name: '1 octobre', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(field(page)).toHaveValue('jeu. 1 oct.');
    });

    test('puces « Aujourd’hui », « Demain », « Lundi prochain », « Un jour » (critère 10)', async ({ page }) => {
      for (const [name, value] of [
        ['Demain', 'Demain'],
        ['Lundi prochain', 'lun. 28 sept.'],
        ['Aujourd’hui', 'Aujourd’hui'],
        ['Un jour', 'Un jour'],
      ] as const) {
        await field(page).click();
        await popover(page).getByRole('button', { name, exact: true }).click();
        await expect(field(page)).toHaveValue(value);
      }
    });

    test('champ « Heure » : « 10 », « 10h », « 10:00 », « 1030 » ; vide = sans heure (critère 11)', async ({ page }) => {
      await field(page).fill('25/09');
      const time = popover(page).getByRole('textbox', { name: 'Heure' });
      for (const [input, shown] of [
        ['10', '10:00'],
        ['10h', '10:00'],
        ['10:00', '10:00'],
        ['1030', '10:30'],
      ] as const) {
        await time.fill(input);
        await expect(popover(page)).toContainText(`Compris : vendredi 25 sept. à ${shown}`);
      }
      await time.fill('');
      await expect(popover(page)).toContainText('Compris : vendredi 25 sept.');
      await expect(popover(page)).not.toContainText(' à ');
    });

    test('la saisie rapide crée la tâche à la date et à l’heure comprises ; pas de champ natif (critères 7, 13, 14)', async ({ page }) => {
      await expect(page.locator('input[type="date"], input[type="time"]')).toHaveCount(0);
      await field(page).fill('aujourd’hui 14:30');
      await page.getByLabel('Nouvelle tâche').fill('Réunion');
      await page.getByLabel('Nouvelle tâche').press('Enter');
      await expect(page.locator('.ct-list-row', { hasText: 'Réunion' })).toContainText('14:30');

      // « Un jour » : sans date ni heure, la tâche quitte Aujourd'hui.
      await field(page).fill('un jour');
      await field(page).press('Enter');
      await page.getByLabel('Nouvelle tâche').fill('Plus tard');
      await page.getByLabel('Nouvelle tâche').press('Enter');
      await expect(page.getByLabel('Nouvelle tâche')).toHaveValue('');
      await expect(page.getByText('Plus tard')).toHaveCount(0);
    });

    test('« Choisir une date » du report utilise le même sélecteur : saisie libre, calendrier, Échap (critère 13)', async ({ page }) => {
      await page.getByLabel('Nouvelle tâche').fill('À reporter');
      await page.getByLabel('Nouvelle tâche').press('Enter');
      await page.getByRole('button', { name: 'À reporter' }).click();
      const detail = page.getByRole('complementary', { name: 'Détail de la tâche' });
      await detail.getByRole('button', { name: 'Reporter', exact: true }).click();
      await page.getByRole('menu', { name: 'Reporter la tâche' }).getByText('Choisir une date', { exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Choisir une date' });

      await expect(dialog.getByRole('textbox', { name: 'Date' })).toBeFocused();
      await dialog.getByRole('textbox', { name: 'Date' }).fill('ven 10h');
      await expect(dialog).toContainText('Compris : vendredi 25 sept.');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveCount(0); // rien n'a été reporté

      await detail.getByRole('button', { name: 'Reporter', exact: true }).click();
      await page.getByRole('menu', { name: 'Reporter la tâche' }).getByText('Choisir une date', { exact: true }).click();
      await dialog.getByRole('button', { name: '30 septembre' }).click();
      await dialog.getByRole('button', { name: 'Valider' }).click();
      await expect(page.getByRole('status')).toContainText('« À reporter » reportée au mer. 30 sept.');
    });
  });
});
