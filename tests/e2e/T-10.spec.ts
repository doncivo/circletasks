import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-10 : Je modifie ou arrête une récurrence.
 *
 * Horloge Playwright : le 23 sept. 2026 à 09:00 (Europe/Paris). Couverture : question « Cette occurrence /
 * Toutes les suivantes / Annuler » à la modification de la note (critères 1 à 3) et annulation par le message
 * (8) ; règle : fin à une date (5, 8), après N occurrences (5, 8), « toutes les suivantes » seul proposé (4),
 * fin avant la tâche refusée avec un message (9) ; « Arrêter la répétition » (6) ; suppression d'une occurrence,
 * « cette occurrence » génère la suivante, « toutes les suivantes » arrête la série (7).
 * iPhone : la tâche mensuelle est créée dans la feuille « Nouvelle tâche » ; PC : « Répéter… » dans la fiche.
 * Les cas fins (reports de minuit, fin par date dépassée, rangs) sont couverts en tests d'intégration.
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

/** Crée une tâche mensuelle (le 23) : feuille « Nouvelle tâche » sur iPhone, « Répéter… » dans la fiche sur PC. */
async function createMonthly(page: Page, info: Info, title: string): Promise<void> {
  if (isIphone(info)) {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByRole('radio', { name: 'Mensuel' }).click();
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(title);
  await field.press('Enter');
  await expect(field).toHaveValue('');
  const detail = await openDetail(page, title);
  await detail.getByRole('button', { name: 'Rendre la tâche récurrente' }).click();
  await detail.getByRole('radio', { name: 'Mensuel' }).click();
  await detail.getByRole('button', { name: 'Valider' }).click();
  await closeDetail(page, detail);
}

async function openDetail(page: Page, title: string): Promise<Locator> {
  await page.getByRole('button', { name: title }).click();
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

/**
 * Clique « Annuler » dans le message. Sur iPhone la fiche est une feuille modale qui recouvre le message : on la ferme
 * d'abord puis on la rouvre ; rend la fiche ouverte.
 */
async function clickUndo(page: Page, info: Info, detail: Locator, title: string): Promise<Locator> {
  if (isIphone(info)) await closeDetail(page, detail);
  await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
  return isIphone(info) ? openDetail(page, title) : detail;
}

/**
 * Ouvre l'éditeur de règle et rend sa portée. PC : la ligne Répétition de la fiche ; iPhone (Q15) : « Modifier » ouvre la feuille
 * d'ajout pré-remplie, qui porte le même sélecteur de répétition.
 */
async function openRuleEditor(page: Page, info: Info, detail: Locator): Promise<Locator> {
  if (isIphone(info)) {
    await detail.getByRole('button', { name: 'Modifier', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Modifier la tâche' });
    await expect(sheet).toBeVisible();
    return sheet;
  }
  await detail.getByRole('button', { name: 'Modifier la répétition de la tâche' }).click();
  return detail;
}

/** Valide l'éditeur de règle : « Valider » (PC) ou « Enregistrer » (feuille iPhone). */
const applyRule = (scope: Locator, info: Info) => scope.getByRole('button', { name: isIphone(info) ? 'Enregistrer' : 'Valider', exact: true }).click();

/** Ouvre l'éditeur de règle, choisit « Autre » et rend sa portée. */
async function openEndEditor(page: Page, info: Info, detail: Locator): Promise<Locator> {
  const scope = await openRuleEditor(page, info, detail);
  await scope.getByRole('button', { name: /Autre : tous les N jours/ }).click();
  return scope;
}

/** « Arrêter la répétition » : bouton de l'éditeur (PC) ou choix « Une fois » dans la feuille « Modifier » (iPhone). */
async function stopRule(page: Page, info: Info, detail: Locator): Promise<void> {
  const scope = await openRuleEditor(page, info, detail);
  if (isIphone(info)) {
    await scope.getByRole('radio', { name: 'Une fois' }).click();
    await applyRule(scope, info);
  } else await scope.getByRole('button', { name: 'Arrêter la répétition' }).click();
}

test.describe('T-10 : modifier ou arrêter une récurrence', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: START });
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('modifier la note : la question s’affiche, « Cette occurrence » puis « Annuler » du message (critères 1, 2, 8)', async ({ page }, info) => {
    const title = `Loyer ${info.project.name}`;
    await createMonthly(page, info, title);
    let detail = await openDetail(page, title);

    let note = detail.getByLabel('Note');
    await note.fill('virement du 23');
    await note.blur();
    const question = page.getByRole('alertdialog', { name: `Modifier « ${title} » ?` });
    await expect(question).toBeVisible();
    await expect(question.getByRole('button', { name: 'Cette occurrence' })).toBeVisible();
    await expect(question.getByRole('button', { name: 'Toutes les suivantes' })).toBeVisible();
    await expect(question.getByRole('button', { name: 'Annuler' })).toBeFocused();

    await question.getByRole('button', { name: 'Cette occurrence' }).click();
    await expect(question).not.toBeVisible();
    await expect(note).toHaveValue('virement du 23');
    await expect(page.getByRole('status')).toContainText('modifiée (cette occurrence)');

    detail = await clickUndo(page, info, detail, title);
    note = detail.getByLabel('Note');
    await expect(note).toHaveValue('');
  });

  test('« Toutes les suivantes », puis « Annuler » dans la question ne change rien (critères 1, 3)', async ({ page }, info) => {
    const title = `Série ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);
    const note = detail.getByLabel('Note');

    await note.fill('annulée');
    await note.blur();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await expect(note).toHaveValue('');
    await expect(page.getByRole('status')).toHaveCount(0);

    await note.fill('nouveau bail');
    await note.blur();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(page.getByRole('status')).toContainText('modifiée (toutes les suivantes)');
    await expect(note).toHaveValue('nouveau bail');
  });

  test('« Cette occurrence » : un mois plus tard, la suivante reprend les valeurs de la série (critère 2)', async ({ page }, info) => {
    const title = `Reprise ${info.project.name}`;
    await createMonthly(page, info, title);
    let detail = await openDetail(page, title);
    await detail.getByLabel('Note').fill('seulement ce mois');
    await detail.getByLabel('Note').blur();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cette occurrence' }).click();
    await closeDetail(page, detail);

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    detail = await openDetail(page, title);
    await expect(detail.getByLabel('Note')).toHaveValue('');
  });

  test('règle : fin le 31 déc. 2026, seul « Toutes les suivantes » est proposé ; le détail affiche la fin (critères 4, 5, 8)', async ({ page }, info) => {
    const title = `Fin date ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);

    const scope = await openEndEditor(page, info, detail);
    await scope.getByRole('radio', { name: 'Fin le' }).click();
    await scope.getByLabel('Date de fin').fill('2026-12-31');
    await applyRule(scope, info);
    const question = page.getByRole('alertdialog', { name: 'Modifier la répétition ?' });
    await expect(question.getByRole('button', { name: 'Cette occurrence' })).toHaveCount(0);
    await question.getByRole('button', { name: 'Toutes les suivantes' }).click();

    await expect(detail.getByTestId('recurrence-detail')).toContainText(/Mensuelle, le 23, jusqu.au 31 déc\. 2026/);
    await expect(page.getByRole('status')).toContainText('Répétition de');
  });

  test('règle : fin le 30 sept. 2026, aucune occurrence n’est créée après cette date (critère 5)', async ({ page }, info) => {
    const title = `Fin courte ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);
    const scope = await openEndEditor(page, info, detail);
    await scope.getByRole('radio', { name: 'Fin le' }).click();
    await scope.getByLabel('Date de fin').fill('2026-09-30');
    await applyRule(scope, info);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await closeDetail(page, detail);

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toHaveCount(0);
  });

  test('règle : après 1 occurrence, la terminée ne crée pas de suivante ; « 6 fois » dans le détail (critères 5, 8)', async ({ page }, info) => {
    const title = `Fin nombre ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);

    const scope = await openEndEditor(page, info, detail);
    await scope.getByRole('radio', { name: 'Après' }).click();
    await scope.getByLabel('Nombre d’occurrences').fill('6');
    await applyRule(scope, info);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(detail.getByTestId('recurrence-detail')).toContainText('Mensuelle, le 23, 6 fois');

    const again = await openRuleEditor(page, info, detail);
    await again.getByLabel('Nombre d’occurrences').fill('1');
    await applyRule(again, info);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(detail.getByTestId('recurrence-detail')).toContainText('1 fois');
    await closeDetail(page, detail);

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('règle : une fin avant la date de la tâche est refusée avec un message clair, la règle est inchangée (critère 9)', async ({ page }, info) => {
    const title = `Fin refusée ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);

    const scope = await openEndEditor(page, info, detail);
    await scope.getByRole('radio', { name: 'Fin le' }).click();
    await scope.getByLabel('Date de fin').fill('2026-09-10');
    await applyRule(scope, info);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(detail.getByRole('alert')).toContainText('La date de fin précède la date de la tâche.');
    await expect(detail.getByTestId('recurrence-detail')).toHaveText('Mensuelle, le 23');
  });

  test('« Arrêter la répétition » : « Une fois » dans le détail, aucune suivante, « Annuler » rétablit la règle (critères 6, 8)', async ({ page }, info) => {
    const title = `Arrêt ${info.project.name}`;
    await createMonthly(page, info, title);
    let detail = await openDetail(page, title);
    await expect(detail.getByTestId('recurrence-detail')).toHaveText('Mensuelle, le 23');

    await stopRule(page, info, detail);
    await expect(detail.getByTestId('recurrence-detail')).toHaveText('Une fois');
    await expect(page.getByRole('status')).toContainText('Répétition de');

    detail = await clickUndo(page, info, detail, title);
    await expect(detail.getByTestId('recurrence-detail')).toHaveText('Mensuelle, le 23');

    await stopRule(page, info, detail);
    await closeDetail(page, detail);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('supprimer « Cette occurrence » génère la suivante au 23 oct. (critère 7)', async ({ page }, info) => {
    const title = `Suppr occurrence ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);

    await detail.getByRole('button', { name: isIphone(info) ? 'Supprimer la tâche' : 'Supprimer', exact: true }).click();
    const question = page.getByRole('alertdialog', { name: `Supprimer « ${title} » ?` });
    await expect(question.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await question.getByRole('button', { name: 'Cette occurrence' }).click();
    await expect(detail).not.toBeVisible();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(`« ${title} » supprimée`);

    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(1);
  });

  test('supprimer « Toutes les suivantes » arrête la série ; « Annuler » rétablit la tâche (critères 7, 8)', async ({ page }, info) => {
    const title = `Suppr série ${info.project.name}`;
    await createMonthly(page, info, title);
    let detail = await openDetail(page, title);
    const deleteLabel = isIphone(info) ? 'Supprimer la tâche' : 'Supprimer';

    await detail.getByRole('button', { name: deleteLabel, exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();

    detail = await openDetail(page, title);
    await detail.getByRole('button', { name: deleteLabel, exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Toutes les suivantes' }).click();
    await advanceDays(page, 30);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('23');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveCount(0);
  });

  test('reporter une occurrence : la question s’affiche depuis la fiche, « Cette occurrence » la reporte à demain (critère 4)', async ({ page }, info) => {
    const title = `Report ${info.project.name}`;
    await createMonthly(page, info, title);
    const detail = await openDetail(page, title);
    await detail.getByRole('button', { name: 'Reporter' }).click();
    await page.getByRole(isIphone(info) ? 'button' : 'menuitem', { name: 'Demain', exact: true }).click();
    const question = page.getByRole('alertdialog', { name: `Reporter « ${title} » ?` });
    await expect(question.getByRole('button', { name: 'Toutes les suivantes' })).toBeVisible();
    await question.getByRole('button', { name: 'Cette occurrence' }).click();
    await expect(question).not.toBeVisible();
    await closeDetail(page, detail);
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
  });

  test('PC : Ctrl+D sur une ligne récurrente propose la même question (critère 4)', async ({ page }, info) => {
    test.skip(isIphone(info), 'Raccourci clavier PC uniquement');
    const title = `Ctrl D ${info.project.name}`;
    await createMonthly(page, info, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();
    await page.keyboard.press('Control+d');
    const question = page.getByRole('alertdialog', { name: `Reporter « ${title} » ?` });
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: 'Toutes les suivantes' }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('PC : touche Suppr sur une ligne récurrente propose la même question (critère 7)', async ({ page }, info) => {
    test.skip(isIphone(info), 'Touche Suppr : clavier PC uniquement');
    const title = `Suppr clavier ${info.project.name}`;
    await createMonthly(page, info, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();
    await page.keyboard.press('Delete');
    const question = page.getByRole('alertdialog', { name: `Supprimer « ${title} » ?` });
    await expect(question.getByRole('button', { name: 'Cette occurrence' })).toBeVisible();
    await question.getByRole('button', { name: 'Cette occurrence' }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });
});
