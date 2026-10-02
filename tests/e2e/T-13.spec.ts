import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T-13 — J'annule ma dernière action.
 *
 * Couverture : message « Annuler » après terminer, reporter, supprimer (critère 1), annulation
 * par le bouton (2), trois annulations successives par Ctrl+Z après disparition des messages (4),
 * Ctrl+Z global depuis un autre onglet (4), bandeau au-dessus de la fiche détail et annoncé
 * (role="status", 9), délai de 5 s suspendu au survol (9), absence de message pour la création (10).
 * La pile de 20, le lot au pluriel, 'stale' et la pause au focus sont couverts en tests unitaires.
 * Exécuté sur `pc` et `iphone` (Ctrl+Z envoyé au clavier sur les deux).
 */

type Info = { project: { name: string } };

async function createTask(page: Page, testInfo: Info, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter' }).click();
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

function detailOf(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Détail de la tâche' }).or(page.getByRole('complementary', { name: 'Détail de la tâche' }));
}

async function openDetail(page: Page, title: string): Promise<Locator> {
  await page.getByRole('button', { name: title, exact: true }).click();
  const detail = detailOf(page);
  await expect(detail).toBeVisible();
  return detail;
}

async function closeDetail(page: Page, testInfo: Info): Promise<void> {
  if (testInfo.project.name === 'iphone') await detailOf(page).getByRole('button', { name: 'Fermer' }).click();
  else await page.keyboard.press('Escape');
  await expect(detailOf(page)).toHaveCount(0);
}

const status = (page: Page): Locator => page.getByRole('status');

test.describe('T-13 — annulation généralisée', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('terminer, reporter, supprimer puis 3 × Ctrl+Z rétablissent tout (critères 1, 2, 4)', async ({ page }, testInfo) => {
    const tag = testInfo.project.name;
    const a = `Terminée ${tag}`;
    const b = `Reportée ${tag}`;
    const c = `Supprimée ${tag}`;
    for (const title of [a, b, c]) await createTask(page, testInfo, title);

    // 1. Terminer.
    await page.getByRole('checkbox', { name: `Terminer : ${a}` }).click();
    await expect(status(page)).toContainText(`« ${a} » terminée`);

    // 2. Reporter à demain (fiche détail).
    let detail = await openDetail(page, b);
    await detail.getByRole('button', { name: 'Reporter', exact: true }).click();
    const menu = testInfo.project.name === 'iphone' ? page.getByRole('dialog', { name: 'Reporter la tâche' }) : page.getByRole('menu', { name: 'Reporter la tâche' });
    await menu.getByRole(testInfo.project.name === 'iphone' ? 'button' : 'menuitem', { name: 'Demain' }).click();
    await expect(status(page)).toContainText(`« ${b} » reportée à demain`);
    await closeDetail(page, testInfo);
    await expect(page.getByRole('button', { name: b, exact: true })).toHaveCount(0);

    // 3. Supprimer (fiche détail + confirmation).
    detail = await openDetail(page, c);
    await detail.getByRole('button', { name: /^Supprimer/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    await expect(status(page)).toContainText(`« ${c} » supprimée`);
    await expect(page.getByRole('button', { name: c, exact: true })).toHaveCount(0);

    // Les messages disparaissent après 5 s ; Ctrl+Z annule quand même, dans l'ordre inverse.
    await expect(status(page)).toHaveCount(0, { timeout: 8000 });
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('button', { name: c, exact: true })).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('button', { name: b, exact: true })).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${a}` })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${a}` })).toHaveCount(0);
    // Pile épuisée : une quatrième annulation n'a aucun effet.
    await page.keyboard.press('Control+z');
    await expect(status(page)).toHaveCount(0);
  });

  test('« Annuler » du message rétablit l’action et ferme le message (critère 2)', async ({ page }, testInfo) => {
    const title = `Bouton ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await expect(status(page)).toHaveCount(0); // créer ne produit pas de message (critère 10)
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(status(page)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
  });

  test('le bandeau reste visible et utilisable au-dessus de la fiche détail ouverte (critère 9)', async ({ page }, testInfo) => {
    const title = `Fiche ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    const detail = await openDetail(page, title);
    await detail.getByRole('button', { name: 'Marquer comme terminée' }).click();
    await expect(status(page)).toContainText(`« ${title} » terminée`);
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(detail.getByRole('button', { name: 'Marquer comme terminée' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('Ctrl+Z est global : il fonctionne depuis l’onglet Réglages (critère 4)', async ({ page }, testInfo) => {
    const title = `Global ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await expect(status(page)).toContainText('terminée');
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await page.keyboard.press('Control+z');
    await page.getByRole('navigation').getByText('Tâches', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toBeVisible();
  });

  test('le délai de 5 s est suspendu tant que le bandeau est survolé (critère 9)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'Le survol n’existe pas au toucher');
    const title = 'Survol';
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await status(page).hover();
    await page.waitForTimeout(6500);
    await expect(status(page)).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(status(page)).toHaveCount(0, { timeout: 8000 });
  });
});
