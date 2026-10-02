import { expect, test, type Page } from '@playwright/test';
import { setWheels, typeDate } from './helpers/schedule';

/**
 * T-02 — J'affecte une date et une heure optionnelle.
 *
 * Couverture : heure affichée sous le titre (critère 2), tri par heure croissante
 * puis ordre manuel pour les tâches sans heure (critères 3, 4, Q11), tâche datée
 * sur un autre jour absente d'Aujourd'hui (critère 1). Exécuté sur `pc` (champ
 * Date / Heure de la saisie en ligne) et `iphone` (feuille « Nouvelle tâche »,
 * PRD : les deux portent le champ minimal de T-02, remplacé par le sélecteur
 * adapté à l'appareil de T-14).
 *
 * Hors couverture e2e (voir rapport de livraison) :
 * - visibilité en Semaine (critère 1, 2e partie) : l'écran Semaine (S-01) n'existe
 *   pas encore ; vérifié par `TaskRepository.listForWeek`
 *   (src/db/repositories/sql/taskRepository.test.ts) comme convenu avec le
 *   product-owner pour T-02.
 * - persistance après redémarrage (critère 7) : la base de développement utilisée
 *   par le serveur `npm run dev` est en mémoire et vidée à chaque rechargement
 *   (ADR 0002) ; vérifié par un test d'intégration SQLite réel
 *   (src/features/tasks/createTaskUseCases.test.ts).
 */

/** Crée une tâche depuis le contrôle adapté à l'appareil (pc : saisie en ligne ; iPhone : feuille). */
async function createTask(
  page: Page,
  projectName: string,
  input: { title: string; date?: string; time?: string },
): Promise<void> {
  if (projectName === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(input.title);
    await setWheels(page, dialog, { ...(input.date ? { date: input.date } : {}), ...(input.time ? { time: input.time } : {}) });
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }

  const titleField = page.getByLabel('Nouvelle tâche');
  await titleField.fill(input.title);
  if (input.date || input.time) await typeDate(page, [input.date, input.time].filter(Boolean).join(' '));
  await titleField.press('Enter');
  // Le champ se vide et retrouve le focus après la création (critère 1, T-01) :
  // un signal fiable que la soumission a bien été traitée, y compris quand la
  // tâche créée n'apparaît pas dans Aujourd'hui (datée sur un autre jour).
  await expect(titleField).toHaveValue('');
}

test.describe('T-02 — date et heure optionnelle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('l’heure d’une tâche est affichée sous son titre, au format 24 h (critère 2)', async ({ page }, testInfo) => {
    const title = `Tâche avec heure ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo.project.name, { title, time: '14:00' });

    const row = page.locator('.ct-list-row', { hasText: title });
    await expect(row).toContainText('14:00');
  });

  test('les tâches à l’heure sont triées par heure croissante, avant celles sans heure (critères 3, 4, Q11)', async ({
    page,
  }, testInfo) => {
    const stamp = Date.now();
    const a = `A 14h ${testInfo.project.name} ${stamp}`;
    const b = `B 09h ${testInfo.project.name} ${stamp}`;
    const c = `C sans heure ${testInfo.project.name} ${stamp}`;
    const d = `D sans heure ${testInfo.project.name} ${stamp}`;

    await createTask(page, testInfo.project.name, { title: a, time: '14:00' });
    await createTask(page, testInfo.project.name, { title: b, time: '09:00' });
    await createTask(page, testInfo.project.name, { title: c });
    await createTask(page, testInfo.project.name, { title: d });

    const titles = page.locator('.ct-list-row__title');
    await expect(titles).toContainText([b, a, c, d]);
  });

  test('une tâche datée sur un autre jour n’apparaît pas dans Aujourd’hui (critère 1)', async ({ page }, testInfo) => {
    const stamp = Date.now();
    const futureTitle = `Dans 10 jours ${testInfo.project.name} ${stamp}`;
    const todayTitle = `Aujourd’hui ${testInfo.project.name} ${stamp}`;
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const futureIso = future.toISOString().slice(0, 10);

    await createTask(page, testInfo.project.name, { title: futureTitle, date: futureIso });
    // Une seconde tâche sans date explicite (aujourd'hui) confirme que la liste se
    // recharge normalement : si elle n'apparaissait pas non plus, l'absence de la
    // première tâche ne prouverait rien sur le critère testé.
    await createTask(page, testInfo.project.name, { title: todayTitle });

    await expect(page.getByText(todayTitle)).toBeVisible();
    await expect(page.getByText(futureTitle)).not.toBeVisible();
  });
});
