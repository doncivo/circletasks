import { expect, test, type Locator, type Page } from '@playwright/test';
import { addIsoDays, browserToday, dayLabel, setWheels } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, dayTitles, insertTasks, openWeek, taskButton } from './helpers/week';

/**
 * S-02 — Je déplace une tâche d'un jour à l'autre.
 *
 * Couverture : souris (`pc`) glisser vers un autre jour avec zone « Déposer ici », date mise à jour tout de suite et conservée
 * (1, 2), annulation par le bandeau (3), Échap et lâcher hors d'un jour sans effet (5), tâche terminée déplaçable (7),
 * réordonnancement dans le même jour (10) ; toucher (`iphone`) : appui long = glisser, simple toucher = fiche, défilement
 * automatique (4) ; clavier : Alt+→ / Alt+← et Ctrl+D (9, les deux projets). Une tâche récurrente pose la question de portée
 * (T-10). Routines et événements non déplaçables : test unitaire (aucun module de routines) et S-05 (événements).
 */

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error('élément introuvable à l’écran');
  return found;
};

/** Souris : saisit la carte, la porte au centre de `to` par petits pas, laisse la main au test avant le lâcher. */
async function mouseDragTo(page: Page, card: Locator, to: Locator, release = true): Promise<void> {
  const from = await box(card);
  const target = await box(to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height - 8, 120), { steps: 12 });
  if (release) await page.mouse.up();
}

/** Toucher : appui long de 500 ms sur la carte puis glisser vers `to` (événements tactiles réels, CDP). */
async function touchDragTo(page: Page, card: Locator, to: Locator, offsetY = 24): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const from = await box(card);
  const target = await box(to);
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(550);
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + ((target.x + target.width / 2 - x) * i) / steps, y: y + ((target.y + offsetY - y) * i) / steps }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('S-02 — déplacer une tâche d’un jour à l’autre', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  /** Lundi, mardi, mercredi… de la semaine courante du navigateur. */
  async function days(page: Page): Promise<[string, string, string, string, string, string, string]> {
    const monday = await browserMonday(page);
    const [, a, b, c, d, e, f] = [0, 1, 2, 3, 4, 5, 6].map((i) => addIsoDays(monday, i)) as [string, string, string, string, string, string, string];
    return [monday, a, b, c, d, e, f];
  }

  test('glisser une carte vers un autre jour : zone « Déposer ici », date mise à jour, annulable (critères 1, 2, 3, 4)', async ({ page }, testInfo) => {
    const [, , wed, thu] = await days(page);
    const title = `Envoyer la facture ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, time: '09:00', space: 'perso' }]);
    await openWeek(page);
    await expect(dayOf(page, wed)).toContainText(title);

    if (isPhone(testInfo)) {
      // Un simple toucher ouvre la fiche (Q16)…
      await taskButton(page, title).tap();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Fermer' }).first().click();
      await expect(page.getByRole('dialog')).toBeHidden();
      // …un appui long saisit la ligne sans ouvrir la fiche.
      await touchDragTo(page, taskButton(page, title), dayOf(page, thu));
      await expect(page.getByRole('dialog')).toBeHidden();
    } else {
      await mouseDragTo(page, taskButton(page, title), dayOf(page, thu), false);
      await expect(page.getByText(`Déposer ici · ${dayLabel(thu).replace(/ [a-zéû]+\.?$/, '')}`)).toBeVisible();
      await page.mouse.up();
    }

    // La carte est dans le nouveau jour, avec son heure et son espace, et la fiche ne s'est pas ouverte.
    await expect(dayOf(page, thu)).toContainText(title);
    await expect(dayOf(page, wed)).not.toContainText(title);
    await expect(dayOf(page, thu)).toContainText('09:00');
    await expect(page.getByRole('status')).toContainText(`« ${title} » déplacée au ${dayLabel(thu)}`);

    // La date est enregistrée : elle survit au changement d'onglet.
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await expect(dayOf(page, thu)).toContainText(title);

    // Annuler remet la tâche au mercredi.
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(dayOf(page, wed)).toContainText(title);
    await expect(dayOf(page, thu)).not.toContainText(title);
  });

  test('une tâche terminée est déplaçable et reste terminée (critère 7)', async ({ page }, testInfo) => {
    const [, , wed, thu] = await days(page);
    const title = `Terminée ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, done: true }]);
    await openWeek(page);
    if (isPhone(testInfo)) await touchDragTo(page, taskButton(page, title), dayOf(page, thu));
    else await mouseDragTo(page, taskButton(page, title), dayOf(page, thu));
    await expect(dayOf(page, thu)).toContainText(title);
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();
  });

  test('Échap, ou un lâcher hors d’un jour, ne change rien (critère 5)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Échap et lâcher hors zone : scénario souris (PC).');
    const [, , wed, thu] = await days(page);
    const title = `Immobile ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, space: 'pro' }]);
    await openWeek(page);

    await mouseDragTo(page, taskButton(page, title), dayOf(page, thu), false);
    await expect(page.locator('.ct-week__dropHere')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.ct-week__dropHere')).toHaveCount(0);
    await expect(dayOf(page, wed)).toContainText(title);

    // Lâcher sur l'en-tête de l'écran : aucune zone sous le pointeur.
    const card = await box(taskButton(page, title));
    await page.mouse.move(card.x + 20, card.y + 10);
    await page.mouse.down();
    await page.mouse.move(card.x + 40, card.y + 20, { steps: 3 });
    await page.mouse.move(300, 30, { steps: 8 });
    await page.mouse.up();
    await expect(dayOf(page, wed)).toContainText(title);
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('déposer dans le même jour réordonne les tâches sans heure ; l’heure garde sa place (critère 10)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Réordonnancement par glisser : scénario souris (PC) ; au clavier, voir le test suivant.');
    const [, , wed] = await days(page);
    const tag = testInfo.project.name;
    const [timed, a, b, c] = [`À 09h ${tag}`, `A ${tag}`, `B ${tag}`, `C ${tag}`];
    await insertTasks(page, [
      { title: timed, date: wed, time: '09:00' },
      { title: a, date: wed, space: 'pro' },
      { title: b, date: wed, space: 'pro' },
      { title: c, date: wed, space: 'pro' },
    ]);
    await openWeek(page);
    await expect.poll(() => dayTitles(page, wed)).toEqual([timed, a, b, c]);

    // C lâchée au-dessus de A : A, B, C devient C, A, B.
    const first = await box(taskButton(page, a));
    const last = await box(taskButton(page, c));
    await page.mouse.move(last.x + 10, last.y + 10);
    await page.mouse.down();
    await page.mouse.move(last.x + 14, last.y - 4, { steps: 3 });
    await page.mouse.move(first.x + 20, first.y + 2, { steps: 8 });
    await expect(page.locator('.ct-week__itemSlot[data-insert="before"]')).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(() => dayTitles(page, wed)).toEqual([timed, c, a, b]);

    // Lâchée tout en haut, au-dessus de la tâche à 09:00 : elle ne passe pas devant elle (l'heure prime).
    const top = await box(taskButton(page, timed));
    const moved = await box(taskButton(page, b));
    await page.mouse.move(moved.x + 10, moved.y + 10);
    await page.mouse.down();
    await page.mouse.move(moved.x + 14, moved.y - 4, { steps: 3 });
    await page.mouse.move(top.x + 20, top.y + 1, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => dayTitles(page, wed)).toEqual([timed, b, c, a]);
  });

  test('au clavier : Alt+→ / Alt+← changent la tâche de jour, Ctrl+D la reporte à demain (critère 9)', async ({ page }, testInfo) => {
    const [, , wed, thu] = await days(page);
    const today = await browserToday(page);
    const title = `Clavier ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, space: 'pro' }]);
    await openWeek(page);

    await taskButton(page, title).focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(dayOf(page, thu)).toContainText(title);
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(dayOf(page, wed)).toContainText(title);
    await expect(page.getByRole('status')).toContainText(`« ${title} » déplacée au`);

    // Ctrl+D : demain (T-05), calculé depuis aujourd'hui.
    await taskButton(page, title).focus();
    await page.keyboard.press('Control+d');
    await expect(page.getByRole('status')).toContainText(`« ${title} » reportée à demain`);
    const tomorrow = addIsoDays(today, 1);
    if ((await days(page)).includes(tomorrow)) await expect(dayOf(page, tomorrow)).toContainText(title);
  });

  test('« Reporter » → « Choisir une date » de la fiche est l’autre voie sans glisser (critère 9)', async ({ page }, testInfo) => {
    const week = await days(page);
    const [, , wed] = week;
    const sunday = week[6];
    const title = `Reporter ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, space: 'pro' }]);
    await openWeek(page);
    await taskButton(page, title).click();
    const phone = isPhone(testInfo);
    const detail = phone ? page.getByRole('dialog', { name: 'Détail de la tâche' }) : page.getByRole('complementary', { name: 'Détail de la tâche' });
    await detail.getByRole('button', { name: 'Reporter', exact: true }).click();
    const menu = phone ? page.getByRole('dialog', { name: 'Reporter la tâche' }) : page.getByRole('menu', { name: 'Reporter la tâche' });
    await menu.getByText('Choisir une date', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Choisir une date' });
    if (phone) {
      await dialog.getByRole('button', { name: 'Aujourd’hui' }).click();
      await setWheels(page, dialog, { date: sunday });
    } else {
      const [year, month, day] = sunday.split('-');
      await dialog.getByRole('textbox', { name: 'Date' }).fill(`${day}/${month}/${year}`);
    }
    await dialog.getByRole('button', { name: 'Valider' }).click();
    if (phone) await detail.getByRole('button', { name: 'Fermer' }).click();
    await expect(dayOf(page, sunday)).toContainText(title);
    await expect(dayOf(page, wed)).not.toContainText(title);
  });

  test('une tâche récurrente demande la portée du déplacement : cette occurrence seulement (T-10)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Question de portée : scénario souris (PC).');
    const [, , wed, thu] = await days(page);
    const title = `Chaque jour ${testInfo.project.name}`;
    await insertTasks(page, [{ title, date: wed, space: 'pro', daily: true }]);
    await openWeek(page);
    await mouseDragTo(page, taskButton(page, title), dayOf(page, thu));
    const question = page.getByRole('alertdialog');
    await expect(question).toContainText(`Déplacer « ${title} » ?`);
    // Rien n'a bougé tant que la question n'est pas tranchée ; « Annuler » abandonne.
    await expect(dayOf(page, wed)).toContainText(title);
    await question.getByRole('button', { name: 'Annuler' }).click();
    await expect(dayOf(page, wed)).toContainText(title);

    await mouseDragTo(page, taskButton(page, title), dayOf(page, thu));
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cette occurrence' }).click();
    await expect(dayOf(page, thu)).toContainText(title);
    await expect(page.getByRole('status')).toContainText(title);
  });

  test('iPhone : la liste défile automatiquement près du bord pendant le glisser (critère 4)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Défilement automatique : toucher (iPhone).');
    const [, , wed] = await days(page);
    const title = `Défilement ${testInfo.project.name}`;
    // Une semaine bien remplie : la liste dépasse l'écran.
    const filler = Array.from({ length: 14 }, (_, i) => ({ title: `Remplissage ${String(i + 1)}`, date: wed, space: 'pro' as const }));
    await insertTasks(page, [{ title, date: wed, space: 'pro' }, ...filler]);
    await openWeek(page);
    const main = page.locator('.ct-app-shell__main');
    await expect.poll(() => main.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

    const cdp = await page.context().newCDPSession(page);
    const from = await box(taskButton(page, title));
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(550);
    const viewport = page.viewportSize();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: (viewport?.height ?? 900) - 12 }] });
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  });
});
