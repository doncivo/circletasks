import { addIsoDays, browserToday, dayLabel, setWheels } from './helpers/schedule';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-05 — Je reporte une tâche.
 *
 * Couverture : menu « Reporter » exact (critère 1), « Demain » avec message titré et
 * Annuler (critères 2, 6), « Semaine prochaine » (critère 3), « Choisir une date » avec
 * validation puis Fermer sans effet (critère 4), Ctrl+D puis Ctrl+Z sur PC (critères 5, 6),
 * tâche terminée sans bouton Reporter (critère 9). Exécuté sur `pc` et `iphone`.
 *
 * Les valeurs de date exactes (jeu. 24, lun. 28, heure conservée, dimanche -> lundi,
 * « Un jour » -> Planifier) sont couvertes en tests unitaires : l'horloge du navigateur
 * n'est pas figée ici.
 */

type Info = { project: { name: string } };

async function createTask(page: Page, testInfo: Info, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
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

function detailOf(page: Page, testInfo: Info): Locator {
  return testInfo.project.name === 'iphone'
    ? page.getByRole('dialog', { name: 'Détail de la tâche' })
    : page.getByRole('complementary', { name: 'Détail de la tâche' });
}

/** Ouvre la fiche, choisit une action du menu Reporter. Sur iPhone, ferme ensuite la fiche (le message « Annuler » est dessous). */
async function postponeVia(page: Page, testInfo: Info, title: string, action: string): Promise<void> {
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = detailOf(page, testInfo);
  await detail.getByRole('button', { name: 'Reporter' }).click();
  const menu = testInfo.project.name === 'iphone' ? page.getByRole('dialog', { name: 'Reporter la tâche' }) : page.getByRole('menu', { name: 'Reporter la tâche' });
  await menu.getByText(action, { exact: true }).click();
}

async function closeDetailOnIphone(page: Page, testInfo: Info): Promise<void> {
  if (testInfo.project.name !== 'iphone') return;
  await detailOf(page, testInfo).getByRole('button', { name: 'Fermer' }).click();
  await expect(detailOf(page, testInfo)).not.toBeVisible();
}

test.describe('T-05 — reporter une tâche', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    // Démarrage à froid (Vite optimise ses dépendances, SQLite Wasm s'initialise, 1er passage) : plus de 5 s possible.
  });

  test('le menu propose exactement Demain, Semaine prochaine, Choisir une date ; Échap / Fermer n’applique rien (critère 1)', async ({ page }, testInfo) => {
    const title = `Menu ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title, exact: true }).click();
    const detail = detailOf(page, testInfo);
    await detail.getByRole('button', { name: 'Reporter' }).click();

    if (testInfo.project.name === 'iphone') {
      const sheet = page.getByRole('dialog', { name: 'Reporter la tâche' });
      await expect(sheet.getByRole('button')).toHaveText(['Demain', 'Semaine prochaine', 'Choisir une date', 'Fermer']);
      await sheet.getByRole('button', { name: 'Fermer' }).click();
      await expect(sheet).not.toBeVisible();
    } else {
      const menu = page.getByRole('menu', { name: 'Reporter la tâche' });
      await expect(menu.getByRole('menuitem')).toHaveText(['Demain', 'Semaine prochaine', 'Choisir une date']);
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
    }
    await expect(detail).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('« Demain » : la tâche quitte Aujourd’hui, message avec le titre, Annuler la remet (critères 2, 6)', async ({ page }, testInfo) => {
    const title = `Report ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);

    await postponeVia(page, testInfo, title, 'Demain');
    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée à demain`);
    await closeDetailOnIphone(page, testInfo);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);

    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
  });

  test('« Semaine prochaine » un mercredi (horloge figée) : lundi 28 sept., message daté (critère 3)', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 });
    const title = `Semaine ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);

    await postponeVia(page, testInfo, title, 'Semaine prochaine');

    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée au lun. 28 sept.`);
    await closeDetailOnIphone(page, testInfo);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('« Semaine prochaine » un dimanche (horloge figée) : le lundi suivant est demain (Q4, critère 3)', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date('2026-09-27T10:00:00+02:00'));
    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 });
    const title = `Report fin ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);

    await postponeVia(page, testInfo, title, 'Semaine prochaine');

    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée à demain`);
    await closeDetailOnIphone(page, testInfo);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('« Choisir une date » : Fermer n’applique rien, Valider reporte à la date choisie (critère 4)', async ({ page }, testInfo) => {
    const title = `Date ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title, exact: true }).click();
    const detail = detailOf(page, testInfo);
    const menuOf = () =>
      testInfo.project.name === 'iphone' ? page.getByRole('dialog', { name: 'Reporter la tâche' }) : page.getByRole('menu', { name: 'Reporter la tâche' });

    await detail.getByRole('button', { name: 'Reporter' }).click();
    await menuOf().getByText('Choisir une date', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Choisir une date' });
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);

    await detail.getByRole('button', { name: 'Reporter' }).click();
    await menuOf().getByText('Choisir une date', { exact: true }).click();
    // PC : saisie libre ; iPhone : roue des jours (10 jours plus tard).
    let expectedDay = 'mar. 15 janv.';
    if (testInfo.project.name === 'iphone') {
      const target = addIsoDays(await browserToday(page), 10);
      await dialog.getByRole('button', { name: 'Aujourd’hui' }).click(); // la roue démarre sur demain
      await setWheels(page, dialog, { date: target });
      expectedDay = dayLabel(target);
    } else {
      await dialog.getByRole('textbox', { name: 'Date' }).fill('15/01/2030');
    }
    await dialog.getByRole('button', { name: 'Valider' }).click();

    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée au ${expectedDay}`);
    await closeDetailOnIphone(page, testInfo);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('Ctrl+D reporte la ligne sélectionnée à demain, Ctrl+Z la rétablit (critères 5, 6)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'Raccourci clavier PC');
    const title = `Raccourci ${Date.now()}`;
    await createTask(page, testInfo, title);

    await page.getByRole('button', { name: title, exact: true }).focus();
    await page.keyboard.press('Control+d');
    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée à demain`);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);

    await page.keyboard.press('Control+z');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
  });

  test('une tâche terminée n’a pas de bouton Reporter (critère 9)', async ({ page }, testInfo) => {
    const title = `Terminée ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title, exact: true }).click();
    const detail = detailOf(page, testInfo);
    await expect(detail.getByRole('button', { name: 'Reporter' })).toBeVisible();

    // iPhone : bouton encadré de la fiche ; PC : case de la ligne (le panneau n'a pas ce bouton).
    if (testInfo.project.name === 'iphone') await detail.getByRole('button', { name: 'Marquer comme terminée' }).click();
    else await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();

    await expect(detail.getByRole('button', { name: 'Reporter' })).toHaveCount(0);
  });
});
