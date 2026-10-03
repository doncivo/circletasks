import { expect, test, type Page } from '@playwright/test';
import { createTask, isPhone, openToday, rowOf } from './helpers/today';

/**
 * A-08 — J'ouvre la fiche détail d'une tâche.
 *
 * Couverture : panneau à droite avec ligne surlignée, Échap et retour du focus (PC, critères 1, 3, 4), feuille plein
 * écran iPhone fermée par « Fermer » (2), contenu et boutons (5, 6), édition sur place du titre, de l'heure et de
 * l'espace (PC, 8), refus d'un titre vide (10), « Modifier » = feuille pré-remplie (iPhone, 9, Q15), « Un jour »
 * (6), rôles ARIA (11). Exécuté sur `pc` et `iphone`.
 * Hors couverture : bouton Focus (M10), rappels et objectif modifiables (N-02, OB-03), appui long (A-07, ordre 5).
 */
/** Bouton-titre d'une ligne de la liste (la fiche PC porte aussi un bouton du même nom : son titre modifiable). */
const listTitle = (page: Page, name: string) => page.locator('.ct-today__list').getByRole('button', { name, exact: true });
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));

test.describe('A-08 — fiche détail', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('ouvre la fiche : panneau (PC) ou feuille modale (iPhone), contenu et boutons (critères 1, 2, 5, 6, 11)', async ({ page }, testInfo) => {
    const title = `Facture ${testInfo.project.name}`;
    await createTask(page, testInfo, { title, time: '09:00' });
    await listTitle(page, title).click();
    const fiche = detail(page);
    await expect(fiche).toBeVisible();
    await expect(fiche.getByRole('heading', { name: title })).toBeVisible();
    await expect(fiche.getByLabel('Note')).toBeVisible();
    await expect(fiche.getByRole('button', { name: 'Reporter' })).toBeVisible();
    await expect(fiche.getByRole('button', { name: 'Un jour' })).toBeVisible();
    await expect(fiche.getByRole('button', { name: 'Dupliquer la tâche' })).toBeVisible();
    await expect(fiche.getByRole('button', { name: /^Supprimer/ })).toBeVisible();
    await expect(fiche.getByRole('button', { name: /Focus/ })).toHaveCount(0);
    await expect(fiche).toContainText('Créée le');
    if (isPhone(testInfo)) {
      await expect(page.getByRole('dialog', { name: 'Détail de la tâche' })).toHaveAttribute('aria-modal', 'true');
      await expect(fiche.getByText('Date', { exact: true })).toBeVisible();
      await fiche.getByRole('button', { name: 'Fermer' }).click();
    } else {
      await expect(rowOf(page, title)).toHaveAttribute('data-selected', 'true');
      await expect(fiche.getByText('Non rattachée')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(listTitle(page, title)).toBeFocused();
    }
    await expect(detail(page)).toHaveCount(0);
  });

  test('PC : le panneau suit la tâche choisie et l’édition sur place est enregistrée aussitôt (critères 4, 8)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Édition sur place : PC seulement (iPhone : « Modifier »).');
    const [a, b] = ['Première', 'Seconde'];
    await createTask(page, testInfo, { title: a });
    await createTask(page, testInfo, { title: b });
    await listTitle(page, a).click();
    await expect(detail(page).getByRole('heading', { name: a })).toBeVisible();
    await listTitle(page, b).click();
    await expect(detail(page).getByRole('heading', { name: b })).toBeVisible();

    const fiche = detail(page);
    await fiche.getByRole('heading', { name: b }).getByRole('button').click();
    await fiche.getByLabel('Titre de la tâche').fill('Seconde (modifiée)');
    await page.keyboard.press('Enter');
    await expect(fiche.getByRole('heading', { name: 'Seconde (modifiée)' })).toBeVisible();

    await fiche.getByRole('button', { name: 'Heure : Sans heure' }).click();
    await fiche.getByLabel('Heure').fill('10h30');
    await page.keyboard.press('Enter');
    await fiche.getByRole('button', { name: 'Espace de la tâche : Pro' }).click();
    await fiche.getByRole('group', { name: 'Espace de la tâche' }).getByRole('button', { name: 'Perso' }).click();
    await expect(rowOf(page, 'Seconde (modifiée)').locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('10:30 · Perso');
  });

  test('un titre vidé est refusé et la valeur précédente est rétablie (critère 10)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Édition sur place : PC seulement.');
    await createTask(page, testInfo, { title: 'Titre stable' });
    await listTitle(page, 'Titre stable').click();
    const fiche = detail(page);
    await fiche.getByRole('heading', { name: 'Titre stable' }).getByRole('button').click();
    await fiche.getByLabel('Titre de la tâche').fill('   ');
    await page.keyboard.press('Enter');
    await expect(fiche.getByRole('alert')).toContainText('entre 1 et 200 caractères');
    await expect(fiche.getByRole('heading', { name: 'Titre stable' })).toBeVisible();
  });

  test('iPhone : « Modifier » ouvre la feuille pré-remplie, Enregistrer applique, fermer ne change rien (critère 9, Q15)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Feuille « Modifier » : iPhone seulement.');
    const title = 'À modifier';
    await createTask(page, testInfo, { title });
    await listTitle(page, title).click();
    await detail(page).getByRole('button', { name: 'Modifier' }).click();
    const edit = page.getByRole('dialog', { name: 'Modifier la tâche' });
    await expect(edit.getByLabel('Titre')).toHaveValue(title);
    await edit.getByLabel('Titre').fill('Abandonné');
    await edit.getByRole('button', { name: 'Fermer' }).click();
    await expect(edit).toHaveCount(0);
    await expect(detail(page).getByRole('heading', { name: title })).toBeVisible();

    await detail(page).getByRole('button', { name: 'Modifier' }).click();
    await edit.getByLabel('Titre').fill('Modifiée');
    await edit.getByRole('button', { name: 'Perso' }).click();
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(edit).toHaveCount(0);
    await expect(detail(page).getByRole('heading', { name: 'Modifiée' })).toBeVisible();
    await detail(page).getByRole('button', { name: 'Fermer' }).click();
    await expect(rowOf(page, 'Modifiée').locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('Perso');
  });

  test('« Un jour » range la tâche : elle quitte Aujourd’hui et le message permet d’annuler (critère 6)', async ({ page }, testInfo) => {
    const title = `Plus tard ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    await listTitle(page, title).click();
    await detail(page).getByRole('button', { name: 'Un jour' }).click();
    await expect(page.getByRole('status')).toContainText('mise dans « Un jour »');
    if (isPhone(testInfo)) await detail(page).getByRole('button', { name: 'Fermer' }).click();
    else await page.keyboard.press('Escape');
    await expect(listTitle(page, title)).toHaveCount(0);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(listTitle(page, title)).toBeVisible();
  });
});
