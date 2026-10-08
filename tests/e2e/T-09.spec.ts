import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-09 : Je rends une tâche récurrente.
 *
 * Horloge Playwright : le 23 sept. 2026 à 09:00 (Europe/Paris), un mercredi. Couverture :
 * choix Hebdo / Mensuel / Annuel / Autre et résumé en clair (critères 1 à 4, 6), parcours clé 5
 * (tâche mensuelle terminée, l'occurrence suivante apparaît au 23 oct., critère 7), « Annuler »
 * qui supprime aussi l'occurrence créée (T-13), occurrence non faite : reportée avec badge ET
 * suivante créée à sa date normale, sans doublon (critères 10, 12, Q2).
 * iPhone : la feuille « Nouvelle tâche » (Ajout.html) ; PC : « Répéter… » dans la fiche détail.
 * Les calculs (fins de mois, bissextile, Nᵉ jour de semaine) sont couverts en tests unitaires.
 */

type Info = { project: { name: string } };

const START = new Date('2026-09-23T09:00:00+02:00');
const ONE_DAY_MS = 24 * 60 * 60_000;

/** Avance l'horloge par tranches de 10 jours (Playwright borne un saut à 2³¹ ms) en laissant le report de minuit se faire. */
async function advanceDays(page: Page, days: number): Promise<void> {
  for (let left = days; left > 0; left -= 10) {
    await page.clock.fastForward(Math.min(left, 10) * ONE_DAY_MS);
    await page.waitForTimeout(300);
  }
}

const isIphone = (info: Info) => info.project.name === 'iphone';

/** Crée la tâche (saisie rapide) avec la répétition donnée par son libellé de radio (« Une fois » : aucune). */
async function createTask(page: Page, info: Info, title: string, repeat: 'Une fois' | 'Hebdo' | 'Mensuel' | 'Annuel' = 'Une fois'): Promise<void> {
  if (isIphone(info)) {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await expect(dialog.getByRole('radio', { name: 'Une fois' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('radio', { name: repeat }).click();
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(title);
  await field.press('Enter');
  await expect(field).toHaveValue('');
  if (repeat === 'Une fois') return;
  const detail = await openDetail(page, title);
  await detail.getByRole('button', { name: 'Rendre la tâche récurrente' }).click();
  await detail.getByRole('radio', { name: repeat }).click();
  await detail.getByRole('button', { name: 'Valider' }).click();
  await closeDetail(page, detail);
}

async function openDetail(page: Page, title: string): Promise<Locator> {
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = page.getByLabel('Détail de la tâche');
  await expect(detail).toBeVisible();
  return detail;
}

async function closeDetail(page: Page, detail: Locator): Promise<void> {
  const close = detail.getByRole('button', { name: 'Fermer' });
  if (await close.count()) await close.first().click();
  else await page.keyboard.press('Escape');
  await expect(detail).not.toBeVisible();
}

test.describe('T-09 : récurrence des tâches', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: START });
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('Hebdo : le mercredi est proposé, on coche d’autres jours, la fiche résume la règle (critères 1, 6)', async ({ page }, info) => {
    const title = `Hebdo ${info.project.name}`;
    if (isIphone(info)) {
      await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
      await dialog.getByLabel('Titre').fill(title);
      await dialog.getByRole('radio', { name: 'Hebdo' }).click();
      await expect(dialog.getByRole('button', { name: 'mercredi' })).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'lundi' }).click();
      await dialog.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(dialog).not.toBeVisible();
    } else {
      await createTask(page, info, title);
      const detail = await openDetail(page, title);
      await detail.getByRole('button', { name: 'Rendre la tâche récurrente' }).click();
      await detail.getByRole('radio', { name: 'Hebdo' }).click();
      await expect(detail.getByRole('button', { name: 'mercredi' })).toHaveAttribute('aria-pressed', 'true');
      await detail.getByRole('button', { name: 'lundi' }).click();
      await detail.getByRole('button', { name: 'Valider' }).click();
      await closeDetail(page, detail);
    }
    const detail = await openDetail(page, title);
    await expect(detail.getByText('Toutes les semaines : lun., mer.')).toBeVisible();
    await expect(page.getByText(/hebdo/).first()).toBeVisible();
  });

  test('Mensuel « le 23 », Annuel « chaque 23 sept. », Autre « tous les 3 jours » (critères 2, 3, 4, 6)', async ({ page }, info) => {
    const monthly = `Mensuelle ${info.project.name}`;
    await createTask(page, info, monthly, 'Mensuel');
    let detail = await openDetail(page, monthly);
    await expect(detail.getByText('Mensuelle, le 23')).toBeVisible();
    await closeDetail(page, detail);
    await expect(page.getByText(/mensuelle/).first()).toBeVisible();

    const yearly = `Annuelle ${info.project.name}`;
    await createTask(page, info, yearly, 'Annuel');
    detail = await openDetail(page, yearly);
    await expect(detail.getByText('Annuelle, chaque 23 sept.')).toBeVisible();
    await closeDetail(page, detail);

    // Autre : tous les 3 jours (N ≥ 2).
    const custom = `Tous les 3 jours ${info.project.name}`;
    let scope: Locator;
    if (isIphone(info)) {
      await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
      scope = page.getByRole('dialog', { name: 'Nouvelle tâche' });
      await scope.getByLabel('Titre').fill(custom);
    } else {
      await createTask(page, info, custom);
      scope = await openDetail(page, custom);
      await scope.getByRole('button', { name: 'Rendre la tâche récurrente' }).click();
    }
    await scope.getByRole('button', { name: /Autre : tous les N jours/ }).click();
    await scope.getByRole('radio', { name: 'Tous les N jours' }).click();
    await scope.getByLabel('Nombre de jours').fill('3');
    await expect(scope.getByTestId('recurrence-summary')).toHaveText('Tous les 3 jours');
    await scope.getByRole('button', { name: isIphone(info) ? 'Enregistrer' : 'Valider' }).click();
    if (!isIphone(info)) await closeDetail(page, scope);
    detail = await openDetail(page, custom);
    await expect(detail.getByText('Tous les 3 jours', { exact: true })).toBeVisible();
  });

  test('parcours clé 5 : tâche mensuelle terminée, l’occurrence suivante apparaît le 23 oct. (critère 7)', async ({ page }, info) => {
    const title = `Envoyer la facture ${info.project.name}`;
    await createTask(page, info, title, 'Mensuel');

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(title);

    // Un mois plus tard : l'occurrence du 23 oct. est là, à faire, avec son indicateur « mensuelle ».
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toHaveCount(0);
    await expect(page.getByText(/mensuelle/).first()).toBeVisible();
    const detail = await openDetail(page, title);
    await expect(detail.getByText('Mensuelle, le 23')).toBeVisible();
  });

  test('« Annuler » rouvre la tâche et supprime l’occurrence créée : une seule occurrence un mois plus tard', async ({ page }, info) => {
    const title = `Annulable ${info.project.name}`;
    await createTask(page, info, title, 'Mensuel');
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();

    // Terminée de nouveau le 23 : une seule suivante (au 23 oct.), pas deux.
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(1);
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toHaveCount(0);
  });

  test('occurrence non faite : reportée avec badge et suivante créée au 23 oct., sans doublon (critères 10, 12, Q2)', async ({ page }, info) => {
    const title = `Non faite ${info.project.name}`;
    await createTask(page, info, title, 'Mensuel');

    // Minuit passé : l'occurrence du 23 sept. passe au 24 avec son badge.
    await page.clock.fastForward(16 * 60 * 60_000);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('24');
    await expect(page.getByText('reportée')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(1);

    // Un mois plus tard : l'occurrence reportée (encore à faire) et la suivante du 23 oct. coexistent, exactement deux.
    await advanceDays(page, 29);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(2);
  });
});
