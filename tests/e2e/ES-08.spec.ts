import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addProject, backToToday, filterPill, openSpacesScreen, projectFilterMenu, setTaskProject } from './helpers/spaces';
import { createTask, isPhone, rowOf, todayTab } from './helpers/today';
import { weekTab } from './helpers/week';

/**
 * ES-08 — Je vois statistiques et Focus par espace et projet (partie de l'ordre 1) ; parcours clé 6 (basculer Pro / Perso / Tout et
 * vérifier le filtrage d'Aujourd'hui et de la Semaine ; les Statistiques arrivent à l'ordre 3 avec H-01).
 *
 * Les agrégats (tâches faites, minutes de Focus, validations de routine) et la règle d'espace d'une session Focus sont des fonctions du
 * domaine testées en Vitest (src/domain/filteredAggregates.test.ts). Partie Focus de l'ordre 3 (F-03) : la section CONCENTRATION du
 * rapport suit le même filtre { espace, projet } (critère 5), vérifié en bout en bout ci-dessous ; les tuiles et graphiques du rapport
 * restent à H-01.
 * Ici : le filtre unique { espace, projet } est le même dans tous les écrans (critère 6) : choisi dans Aujourd'hui, il s'applique à la
 * Semaine ; « Tout » le lève. Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-08 — filtre unique espace + projet (parcours clé 6)', () => {
  test('Pro puis un projet filtrent Aujourd’hui et la Semaine ; Perso et Tout les remplacent (critères 3, 6)', async ({ page }, testInfo) => {
    await openApp(page);
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Mission client');
    await backToToday(page);

    await filterPill(page, 'Pro').click();
    await createTask(page, testInfo, { title: 'Facture' });
    await createTask(page, testInfo, { title: 'Réunion' });
    await setTaskProject(page, testInfo, 'Facture', 'Mission client');
    await filterPill(page, 'Perso').click();
    await createTask(page, testInfo, { title: 'Courses' });

    await filterPill(page, 'Tout').click();
    for (const title of ['Facture', 'Réunion', 'Courses']) await expect(rowOf(page, title)).toBeVisible();

    // Pro puis « Mission client » : seules les tâches du projet.
    await filterPill(page, 'Pro').click();
    await expect(rowOf(page, 'Courses')).toHaveCount(0);
    await projectFilterMenu(page).selectOption({ label: 'Mission client' });
    await expect(rowOf(page, 'Facture')).toBeVisible();
    await expect(rowOf(page, 'Réunion')).toHaveCount(0);

    // Même filtre dans la Semaine.
    await weekTab(page).click();
    await expect(filterPill(page, 'Pro')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Facture', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Réunion', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Courses', exact: true })).toHaveCount(0);

    // Perso : le projet est remis à « tous » et masqué ; Tout rend tout.
    await filterPill(page, 'Perso').click();
    await expect(projectFilterMenu(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Courses', exact: true })).toBeVisible();
    await filterPill(page, 'Tout').click();
    for (const title of ['Facture', 'Réunion', 'Courses']) await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  });

  test('Focus : la section CONCENTRATION du rapport suit Pro puis le projet « Mission client » (critère 5, parcours clé 6)', async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-09-23T09:00:00+02:00') });
    await openApp(page);
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Mission client');
    await backToToday(page);
    await filterPill(page, 'Pro').click();
    await createTask(page, testInfo, { title: 'Facture' });
    await createTask(page, testInfo, { title: 'Réunion' });
    await setTaskProject(page, testInfo, 'Facture', 'Mission client');
    await filterPill(page, 'Perso').click();
    await createTask(page, testInfo, { title: 'Courses' });
    await filterPill(page, 'Tout').click();

    // Une session de 25 min par tâche, menée à son terme par un saut d'horloge.
    for (const title of ['Facture', 'Réunion', 'Courses']) {
      await page.locator('.ct-today__list').getByRole('button', { name: title, exact: true }).click();
      await page
        .getByRole('complementary', { name: 'Détail de la tâche' })
        .or(page.getByRole('dialog', { name: 'Détail de la tâche' }))
        .getByRole('button', { name: isPhone(testInfo) ? 'Lancer un Focus' : /^Focus/ })
        .click();
      const session = page.getByRole('region', { name: 'Session Focus' });
      await page.clock.fastForward('26:00');
      await expect(session.getByRole('alert')).toHaveText('Session terminée · 25 min');
      await session.getByRole('button', { name: 'Fermer', exact: true }).click();
    }

    const row = (label: string) => page.getByRole('region', { name: 'CONCENTRATION' }).getByRole('listitem').filter({ hasText: label });
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await expect(row('Ce mois')).toContainText('1 h 15'); // Tout
    await todayTab(page).click();
    await filterPill(page, 'Pro').click();
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await expect(row('Ce mois')).toContainText('50 min');
    await expect(row('Courses')).toHaveCount(0);
    await todayTab(page).click();
    await projectFilterMenu(page).selectOption({ label: 'Mission client' });
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await expect(row('Ce mois')).toContainText('25 min');
    await expect(row('Facture')).toContainText('25 min');
    await expect(row('Réunion')).toHaveCount(0); // sans projet : seulement dans « Tous les projets »
  });
});
