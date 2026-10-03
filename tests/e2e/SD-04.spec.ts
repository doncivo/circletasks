import { expect, test, type Page } from '@playwright/test';
import { addProject, filterPill, openSpacesScreen, projectFilterMenu } from './helpers/spaces';
import { closeSomeday, insertSomeday, openSomeday, somedayButton, somedayList, somedayPane, somedayTitles } from './helpers/someday';
import { isPhone, openToday, todayTab } from './helpers/today';
import { weekTab } from './helpers/week';

/**
 * SD-04 — J'organise la liste « Un jour ». Parcours clé 12 (organisation) : réordonnancement, filtre espace et projet, mode édition
 * et planification par lot, vue compacte mémorisée séparément d'Aujourd'hui. Exécuté sur `pc` (panneau) et `iphone` (écran plein).
 */
const editSwitch = (page: Page) => somedayPane(page).getByRole('button', { name: 'Mode édition' });
const compactToggle = (page: Page) => somedayPane(page).getByRole('button', { name: 'Vue compacte' });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Actions sur la sélection' });

/** Aujourd'hui relit « Un jour » en se remontant : la base du navigateur de développement est en mémoire (pas de rechargement). */
async function remountToday(page: Page): Promise<void> {
  await weekTab(page).click();
  await todayTab(page).click();
}

test.describe('SD-04 — organiser « Un jour »', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('glisser une tâche à une autre position enregistre l’ordre, conservé en changeant d’écran (critère 1)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Tâche A' }, { title: 'Tâche B' }, { title: 'Tâche C' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    expect(await somedayTitles(page)).toEqual(['Tâche A', 'Tâche B', 'Tâche C']);

    if (isPhone(testInfo)) {
      // iPhone : mode édition, poignée (↑ au clavier d'un lecteur d'écran ; le glisser tactile est couvert par A-02).
      await editSwitch(page).click();
      await page.getByRole('button', { name: 'Déplacer : Tâche C' }).focus();
      await page.keyboard.press('ArrowUp');
    } else {
      // PC : saisir la carte C par sa poignée et la lâcher au-dessus de la carte A.
      const handle = page.getByRole('button', { name: 'Déplacer : Tâche C' });
      const target = page.getByRole('button', { name: 'Tâche A', exact: true });
      const from = await handle.boundingBox();
      const to = await target.boundingBox();
      if (!from || !to) throw new Error('éléments introuvables');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 3 });
      await page.mouse.move(to.x + 20, to.y - 10, { steps: 12 });
      await page.mouse.up();
    }
    // iPhone : C monte d'une position ; PC : C est lâchée au-dessus de A.
    await expect.poll(() => somedayTitles(page)).toEqual(isPhone(testInfo) ? ['Tâche A', 'Tâche C', 'Tâche B'] : ['Tâche C', 'Tâche A', 'Tâche B']);

    const order = await somedayTitles(page);
    await closeSomeday(page, testInfo);
    await remountToday(page);
    await openSomeday(page, testInfo);
    expect(await somedayTitles(page)).toEqual(order);
  });

  test('Alt+↓ déplace la tâche sélectionnée au clavier (critère 1)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Raccourci clavier : PC.');
    await insertSomeday(page, [{ title: 'Tâche A' }, { title: 'Tâche B' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Tâche A', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche B', 'Tâche A']);
  });

  test('filtre Perso : seules les tâches Perso, sous-titre et badge comptent celles-ci ; menu Projet sous Pro (critères 3 et 4)', async ({ page }, testInfo) => {
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Mission client');
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await insertSomeday(page, [{ title: 'Tâche Pro' }, { title: 'Tâche projet', project: 'Mission client' }, { title: 'Tâche Perso', space: 'perso' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    await expect(projectFilterMenu(page)).toHaveCount(0);

    await filterPill(page, 'Perso').click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche Perso']);
    if (isPhone(testInfo)) await expect(page.getByText('1 tâche sans date, à planifier plus tard')).toBeVisible();
    await expect(projectFilterMenu(page)).toHaveCount(0);

    await filterPill(page, 'Pro').click();
    await expect(projectFilterMenu(page)).toBeVisible();
    await projectFilterMenu(page).selectOption({ label: 'Mission client' });
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche projet']);
    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
    await filterPill(page, 'Tout').click();
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 3 tâches');
  });

  test('mode édition : sélection, barre, « Planifier » par lot annulable, suppression avec confirmation (critères 5, 6 et 8)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Tâche A' }, { title: 'Tâche B' }, { title: 'Tâche C' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    await editSwitch(page).click();
    await expect(page.getByRole('button', { name: 'Sélectionner : Tâche A' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Supprimer : Tâche A' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Déplacer : Tâche A' })).toBeVisible();

    await page.getByRole('button', { name: 'Sélectionner : Tâche A' }).click();
    await page.getByRole('button', { name: 'Sélectionner : Tâche B' }).click();
    await expect(bar(page)).toContainText('2 sélectionnées');
    await bar(page).getByRole('button', { name: 'Planifier' }).click();
    await page.getByRole(isPhone(testInfo) ? 'button' : 'menuitem', { name: 'Demain' }).click();
    await expect(page.getByRole('status')).toContainText('2 tâches planifiées');
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche C']);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche A', 'Tâche B', 'Tâche C']);

    // Suppression d'une ligne : confirmation, corbeille, annulable.
    await page.getByRole('button', { name: 'Supprimer : Tâche C' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Supprimer « Tâche C » ?');
    await dialog.getByRole('button', { name: 'Supprimer' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche A', 'Tâche B']);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche A', 'Tâche B', 'Tâche C']);

    // Le même interrupteur revient au mode normal.
    await editSwitch(page).click();
    await expect(page.getByRole('checkbox', { name: 'Terminer : Tâche A' })).toBeVisible();
  });

  test('« Déplacer » change l’espace sans toucher à la date : la tâche reste dans « Un jour » (critère 5, Q12)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Tâche A' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    await editSwitch(page).click();
    await page.getByRole('button', { name: 'Sélectionner : Tâche A' }).click();
    await bar(page).getByRole('button', { name: 'Déplacer' }).click();
    await page.getByRole('button', { name: 'Perso · aucun projet' }).click();
    await expect(page.getByRole('status')).toContainText('« Tâche A » déplacée dans Perso');
    await filterPill(page, 'Perso').click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche A']);
    await filterPill(page, 'Pro').click();
    await expect(somedayList(page)).toHaveCount(0);
  });

  test('vue compacte : une ligne par tâche, mémorisée séparément d’Aujourd’hui (critère 7)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Tâche A' }, { title: 'Tâche B', space: 'perso' }]);
    await remountToday(page);
    await openSomeday(page, testInfo);
    const toggle = compactToggle(page);
    await expect(somedayList(page).locator('.ct-list-row__subtitle')).toHaveCount(2);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(somedayList(page).locator('.ct-list-row__subtitle')).toHaveCount(0);
    await expect(somedayList(page).locator('.ct-list-row[data-compact="true"]')).toHaveCount(2);
    await closeSomeday(page, testInfo);
    // Aujourd'hui garde sa propre vue : le bouton « Vue compacte » de la page n'est pas enfoncé.
    await expect(page.getByRole('main').getByRole('button', { name: 'Vue compacte' }).first()).toHaveAttribute('aria-pressed', 'false');
    await openSomeday(page, testInfo);
    await expect(compactToggle(page)).toHaveAttribute('aria-pressed', 'true');
  });
});
