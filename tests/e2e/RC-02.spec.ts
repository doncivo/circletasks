import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertChecklists } from './helpers/checklists';
import { insertEvents } from './helpers/events';
import { insertGoals } from './helpers/goals';
import { addIsoDays, browserToday } from './helpers/schedule';
import { assignProject, chipOf, chooseChip, closeSearch, describeTimings, groupTitles, median, insertSearchTasks, openSearch, resultRows, searchDialog, typeSearch } from './helpers/search';
import { addProject, backToToday, filterPill, openSpacesScreen } from './helpers/spaces';
import { mondayOf } from './helpers/week';

/**
 * RC-02 — Je filtre les résultats. Exécuté sur `pc` et `iphone` (listes natives sur les deux).
 * Couverture : espace et compteur (1), projet (2), type (3), statut (4), période (5), combinaison et « Réinitialiser » (6),
 * filtre global inchangé et filtres non mémorisés (7), mesure @perf des changements de filtre (8), noms accessibles (9).
 */
test.describe('RC-02 — filtres de la recherche', () => {
  async function seed(page: Page): Promise<void> {
    await openApp(page);
    const today = await browserToday(page);
    const monday = mondayOf(today);
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Mission client');
    await backToToday(page);
    await insertSearchTasks(page, [
      { title: 'Facture A', space: 'pro', date: today },
      { title: 'Facture B', space: 'pro', date: addIsoDays(today, -40), done: true },
      { title: 'Facture C', space: 'perso', date: null, someday: true },
    ]);
    await assignProject(page, 'Facture A', 'Mission client');
    await insertChecklists(page, [{ title: 'Facture liste', space: 'pro', date: today }]);
    await insertEvents(page, [{ title: 'Facture événement', date: addIsoDays(today, 70), space: 'perso' }]);
    await insertGoals(page, [{ title: 'Facture objectif', weekStart: monday, space: 'pro' }]);
  }

  async function openFacture(page: Page, testInfo: { project: { name: string } }): Promise<void> {
    await openSearch(page, testInfo);
    await typeSearch(page, 'facture');
    await expect(searchDialog(page).getByText('6 résultats')).toBeVisible();
  }

  test('espace : filtre les résultats et le compteur, sans toucher au filtre global (critères 1 et 7)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await expect(chipOf(page, 'Filtre Espace : Tout')).toBeVisible();
    await chooseChip(page, 'Filtre Espace : Tout', 'Pro');
    await expect(searchDialog(page).getByText('4 résultats')).toBeVisible();
    await expect(chipOf(page, 'Filtre Espace : Pro')).toBeVisible();
    await closeSearch(page, testInfo);
    await expect(filterPill(page, 'Tout')).toHaveAttribute('aria-pressed', 'true');
  });

  test('projet : la puce apparaît sous Pro, qui a un projet, et ne garde que ses tâches (critère 2)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await expect(searchDialog(page).getByRole('combobox', { name: /Filtre Projet/ })).toHaveCount(0);
    await chooseChip(page, 'Filtre Espace : Tout', 'Pro');
    await chooseChip(page, 'Filtre Projet : tous', 'Mission client');
    await expect(searchDialog(page).getByText('1 résultat', { exact: true })).toBeVisible();
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page).first()).toContainText('Facture A');
    await chooseChip(page, 'Filtre Espace : Pro', 'Perso');
    await expect(searchDialog(page).getByRole('combobox', { name: /Filtre Projet/ })).toHaveCount(0);
  });

  test('type : ne garde que les checklists (critère 3)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await chooseChip(page, 'Filtre Type : Tous', 'Checklists');
    await expect(searchDialog(page).getByText('1 résultat', { exact: true })).toBeVisible();
    expect(await groupTitles(page)).toEqual(['Checklists · 1']);
    await expect(chipOf(page, 'Filtre Type : Checklists')).toBeVisible();
  });

  test('statut : « À faire » et « Fait » ne gardent que tâches et objectifs (critère 4)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await chooseChip(page, 'Filtre Statut : Tous', 'À faire');
    await expect(searchDialog(page).getByText('3 résultats')).toBeVisible();
    expect(await groupTitles(page)).toEqual(['Tâches · 2', 'Objectifs · 1']);
    await chooseChip(page, 'Filtre Statut : À faire', 'Fait');
    await expect(searchDialog(page).getByText('1 résultat', { exact: true })).toBeVisible();
    await expect(resultRows(page).first()).toContainText('Facture B');
  });

  test('période : Cette semaine exclut les éléments sans date et les dates hors période (critère 5)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await chooseChip(page, 'Filtre Période', 'Cette semaine');
    // Tâche A (aujourd'hui), checklist (aujourd'hui), objectif de la semaine ; pas la tâche d'il y a 40 jours, pas « Un jour », pas l'événement dans 70 jours.
    await expect(searchDialog(page).getByText('3 résultats')).toBeVisible();
    await expect(chipOf(page, 'Filtre Période : Cette semaine')).toBeVisible();
    await chooseChip(page, 'Filtre Période : Cette semaine', '30 derniers jours');
    await expect(searchDialog(page).getByText('3 résultats')).toBeVisible();
  });

  test('les filtres se combinent et « Réinitialiser » remet tout à zéro (critère 6)', async ({ page }, testInfo) => {
    await seed(page);
    await openFacture(page, testInfo);
    await chooseChip(page, 'Filtre Espace : Tout', 'Pro');
    await chooseChip(page, 'Filtre Statut : Tous', 'À faire');
    await expect(searchDialog(page).getByText('2 résultats')).toBeVisible();
    await searchDialog(page).getByRole('button', { name: 'Réinitialiser' }).click();
    await expect(searchDialog(page).getByText('6 résultats')).toBeVisible();
    await expect(chipOf(page, 'Filtre Espace : Tout')).toBeVisible();
    await expect(searchDialog(page).getByRole('button', { name: 'Réinitialiser' })).toHaveCount(0);
  });

  test('l’espace du filtre global est repris à l’ouverture ; les filtres ne sont pas mémorisés (critère 7)', async ({ page }, testInfo) => {
    await seed(page);
    await filterPill(page, 'Pro').click();
    await openSearch(page, testInfo);
    await expect(chipOf(page, 'Filtre Espace : Pro')).toBeVisible();
    await chooseChip(page, 'Filtre Type : Tous', 'Tâches');
    await closeSearch(page, testInfo);
    await openSearch(page, testInfo);
    await expect(chipOf(page, 'Filtre Type : Tous')).toBeVisible();
  });

  test('chaque changement de filtre relance la requête en moins de 200 ms avec 5 000 tâches (critère 8) @perf', async ({ page }, testInfo) => {
    await openApp(page);
    await page.evaluate(() => window.__ctTest?.seedTasks(5000, '2026-08-01', 100));
    await openSearch(page, testInfo);
    await typeSearch(page, 'tâche 49');
    await expect(searchDialog(page).getByText('100 résultats')).toBeVisible();
    // Mesure dans la page : du changement de la liste native à l'état attendu (résultats ou « Aucun résultat »).
    const measure = async (chip: string, option: string, expected: 'rows' | 'empty'): Promise<number> =>
      page.evaluate(
        async ([name, label, want]) => {
          const select = document.querySelector(`select[aria-label="${name}"]`) as HTMLSelectElement;
          const value = [...select.options].find((o) => o.textContent === label)?.value ?? '';
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          const start = performance.now();
          setter?.call(select, value);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise<void>((resolve) => {
            const check = (): boolean => (want === 'rows' ? document.querySelector('.ct-search__result') !== null : (document.querySelector('.ct-search__count')?.textContent ?? '').startsWith('Aucun résultat'));
            if (check()) return resolve();
            const observer = new MutationObserver(() => {
              if (check()) {
                observer.disconnect();
                resolve();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
          });
          return performance.now() - start;
        },
        [chip, option, expected] as const,
      );
    const timings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      timings.push(await measure('Filtre Statut : Tous', 'Fait', 'empty'));
      timings.push(await measure('Filtre Statut : Fait', 'Tous', 'rows'));
      timings.push(await measure('Filtre Type : Tous', 'Checklists', 'empty'));
      timings.push(await measure('Filtre Type : Checklists', 'Tous', 'rows'));
    }
    const empty = timings.filter((_, index) => index % 2 === 0);
    const withRows = timings.filter((_, index) => index % 2 === 1);
    const report = `${describeTimings('états vides', empty)} ; ${describeTimings('états avec résultats', withRows)}`;
    testInfo.annotations.push({ type: 'mesure', description: report });
    process.stdout.write(`RC-02 ${report}\n`);
    // Médiane de 10 essais par famille d'états (et non le meilleur essai) contre le budget de 200 ms.
    expect(median(empty), 'états vides (médiane)').toBeLessThan(200);
    expect(median(withRows), 'états avec résultats (médiane)').toBeLessThan(200);
  });
});
