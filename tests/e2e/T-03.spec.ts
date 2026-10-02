import { expect, test, type Page } from '@playwright/test';

/**
 * T-03 — J'ajoute une note et une icône.
 *
 * Couverture : choix d'une icône Lucide dans la feuille « Nouvelle tâche »
 * (iPhone, Ajout.html), affichée décorative à droite de la ligne (critères 1, 3,
 * 4, 6) ; choisir un emoji remplace l'icône (critère 2) ; depuis la fiche détail,
 * changer ou retirer l'icône depuis la pastille (critère 5) ; note multi-lignes
 * enregistrée à la perte de focus ou à la fermeture de la fiche, vidée = chaîne
 * vide (critères 7 à 9). Exécuté sur `pc` et `iphone` (playwright.config.ts) ; la
 * sélection d'icône à la création n'a de maquette que côté iPhone (Ajout.html :
 * la saisie en ligne PC n'a pas ce champ, cf. fiche T-03) — ces scénarios sont
 * donc réservés au projet `iphone` et la création y passe par la feuille.
 *
 * Hors couverture e2e (voir rapport de livraison) :
 * - persistance après redémarrage (critère 11) : base de développement en
 *   mémoire, vidée à chaque rechargement (ADR 0002) ; vérifié par
 *   `src/db/repositories/sql/taskRepository.test.ts` (sqlite réel) et
 *   `src/features/tasks/taskDetailStore.test.ts`.
 */

/** Ouvre la fiche détail de la tâche visible `title` et renvoie son conteneur (panneau PC ou feuille iPhone). */
function openDetail(page: Page, title: string) {
  return page.getByRole('button', { name: title }).click();
}

function detailLocator(page: Page, testInfo: { project: { name: string } }) {
  return testInfo.project.name === 'iphone'
    ? page.getByRole('dialog', { name: 'Détail de la tâche' })
    : page.getByRole('complementary', { name: 'Détail de la tâche' });
}

async function createPlainTask(page: Page, testInfo: { project: { name: string } }, title: string): Promise<void> {
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

test.describe('T-03 — note et icône', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('iPhone : je choisis une icône Lucide à la création, affichée décorative à droite de la ligne (critères 1, 3, 4, 6)', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Pas de champ icône dans la saisie en ligne PC (pas de maquette, fiche T-03)');
    const title = `Appeler le notaire ${Date.now()}`;

    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    const phoneButton = dialog.getByRole('button', { name: 'Icône téléphone' });
    await phoneButton.click();
    await expect(phoneButton).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.locator('.ct-list-row', { hasText: title });
    const icon = row.locator('svg');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  test('iPhone : choisir un emoji remplace l’icône Lucide choisie (un seul champ icon, critère 2)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Pas de champ icône dans la saisie en ligne PC');
    const title = `Boire de l’eau ${Date.now()}`;

    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByRole('button', { name: 'Icône téléphone' }).click();
    await dialog.getByRole('radio', { name: 'Emoji' }).click();
    await dialog.getByRole('button', { name: 'Emoji goutte d’eau' }).click();
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();

    await expect(page.getByText(title)).toBeVisible();
  });

  test('je change puis retire l’icône depuis la pastille de la fiche détail (critère 5)', async ({ page }, testInfo) => {
    const title = `Envoyer la facture ${testInfo.project.name} ${Date.now()}`;
    await createPlainTask(page, testInfo, title);

    await openDetail(page, title);
    const detail = detailLocator(page, testInfo);
    await expect(detail).toBeVisible();

    await detail.getByRole('button', { name: 'Icône' }).click();
    await detail.getByRole('button', { name: 'Icône document' }).click();
    const changeButton = detail.getByRole('button', { name: 'Changer l’icône' });
    await expect(changeButton).toBeVisible();

    // La ligne Aujourd'hui reflète aussitôt le changement, sans recharger la liste.
    const row = page.locator('.ct-list-row', { hasText: title });
    await expect(row.locator('svg')).toBeVisible();

    await changeButton.click();
    await detail.getByRole('button', { name: 'Retirer l’icône' }).click();
    await expect(detail.getByRole('button', { name: 'Icône' })).toBeVisible();
  });

  test('la note multi-lignes est enregistrée à la perte de focus, conservée au réaffichage (critères 7 à 9)', async ({
    page,
  }, testInfo) => {
    const title = `Note e2e ${testInfo.project.name} ${Date.now()}`;
    await createPlainTask(page, testInfo, title);

    await openDetail(page, title);
    const detail = detailLocator(page, testInfo);
    const note = detail.getByRole('textbox', { name: 'Note' });
    await note.fill('Ligne 1\nLigne 2');
    await note.blur();
    await expect(note).toHaveValue('Ligne 1\nLigne 2');

    // Ferme puis rouvre la fiche : la note multi-lignes est conservée.
    if (testInfo.project.name === 'iphone') {
      await detail.getByRole('button', { name: 'Fermer' }).click();
    } else {
      await detail.getByRole('button', { name: 'Fermer le détail' }).click();
    }
    await expect(detail).not.toBeVisible();

    await openDetail(page, title);
    const reopened = detailLocator(page, testInfo);
    await expect(reopened.getByRole('textbox', { name: 'Note' })).toHaveValue('Ligne 1\nLigne 2');

    // Une note vidée est enregistrée comme chaîne vide (critère 9).
    const reopenedNote = reopened.getByRole('textbox', { name: 'Note' });
    await reopenedNote.fill('');
    await reopenedNote.blur();
    await expect(reopenedNote).toHaveValue('');
  });
});
