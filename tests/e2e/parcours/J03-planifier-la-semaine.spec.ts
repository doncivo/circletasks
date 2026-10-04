import { expect, test } from '@playwright/test';
import { addIsoDays } from '../helpers/schedule';
import { openToday } from '../helpers/today';
import { browserMonday, dayOf, dayTitles, openWeek, taskButton } from '../helpers/week';

/**
 * Parcours clé 3 (PRD 8) : planifier la semaine (S-01 à S-04). Cinq tâches créées dans les jours, deux déplacées d'un jour à
 * l'autre (clavier Alt+→ / Alt+←, commun PC et iPhone), navigation vers la semaine suivante et retour. Tout passe par l'interface.
 */
test('parcours 3 : créer 5 tâches, en déplacer 2, naviguer à la semaine suivante', async ({ page }, testInfo) => {
  await openToday(page);
  await openWeek(page);
  const monday = await browserMonday(page);
  const tag = testInfo.project.name;
  const plan = [0, 1, 2, 4, 6].map((offset) => ({ iso: addIsoDays(monday, offset), title: `Tâche ${String(offset + 1)} ${tag}` }));

  for (const { iso, title } of plan) {
    await dayOf(page, iso).getByRole('button', { name: /^Ajouter une tâche/ }).click();
    const field = dayOf(page, iso).getByRole('combobox');
    await field.fill(title);
    await field.press('Enter');
    await expect(taskButton(page, title)).toBeVisible();
  }
  for (const { iso, title } of plan) expect(await dayTitles(page, iso)).toEqual([title]);

  // Deux déplacements : la tâche du lundi va au mardi, celle du vendredi revient au jeudi.
  const [first, , , fifth] = plan;
  if (!first || !fifth) throw new Error('jeu de données du parcours incomplet');
  await taskButton(page, first.title).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(dayOf(page, addIsoDays(monday, 1))).toContainText(first.title);
  await expect(dayOf(page, monday)).not.toContainText(first.title);

  await taskButton(page, fifth.title).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(dayOf(page, addIsoDays(monday, 3))).toContainText(fifth.title);
  await expect(dayOf(page, addIsoDays(monday, 4))).not.toContainText(fifth.title);

  // Semaine suivante : sans ces tâches ; retour : elles sont à leur nouvelle place.
  await page.getByRole('button', { name: 'Semaine suivante' }).click();
  await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();
  await expect(taskButton(page, first.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Cette semaine' }).click();
  await expect(dayOf(page, addIsoDays(monday, 1))).toContainText(first.title);
  await expect(dayOf(page, addIsoDays(monday, 3))).toContainText(fifth.title);
});
