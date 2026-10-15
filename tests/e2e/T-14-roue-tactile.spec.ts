import { expect, test, type Locator } from '@playwright/test';
import { openToday } from './helpers/today';

/**
 * T-14 correctif (séance iPhone 0.3.0) et N-02 : l'heure se pose par DÉFILEMENT de la roue « Heures » (chemin du doigt : scroll, pas clavier),
 * puis un rappel se coche dans la feuille, et la fiche le montre. Avant le correctif, la roue ne dépassait pas « 01 » sur l'iPhone : le
 * recalage programmé de `scrollTop` interrompait le geste. Le défilement est simulé comme un doigt : positions intermédiaires, une pause de
 * plus de 90 ms au milieu (fin de défilement détectée, choix appliqué par le parent), puis la suite du geste. Projets `iphone` (Chromium) et
 * `iphone-webkit` (WebKit, moteur de l'iPhone, build de production).
 */
async function dragWheel(wheel: Locator, toIndex: number): Promise<void> {
  const viewport = wheel.locator('.ct-wheel__viewport');
  const itemHeight = 32;
  for (let i = 1; i <= toIndex; i += 1) {
    await viewport.evaluate((el, y) => {
      el.scrollTop = y;
    }, i * itemHeight + (i === toIndex ? 0 : 9));
    // Doigt qui marque un temps au milieu du geste : le choix intermédiaire est appliqué, le geste doit continuer sans recalage.
    if (i === Math.floor(toIndex / 2)) await expect(wheel).toHaveAttribute('aria-valuenow', String(i));
  }
}

test.describe('T-14 correctif : roue des heures au doigt, puis rappel (N-02)', () => {
  test.skip(({ isMobile }) => !isMobile, 'roues de l’iPhone seulement');

  test('défiler la roue Heures jusqu’à 12, les minutes et les rappels s’activent, le rappel coché apparaît dans la fiche', async ({ page }) => {
    await openToday(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill('Rappel au doigt');
    const hours = dialog.getByRole('spinbutton', { name: 'Heures' });
    const minutes = dialog.getByRole('spinbutton', { name: 'Minutes' });
    const atTime = dialog.getByRole('checkbox', { name: 'À l’heure' });
    await expect(hours).toHaveAttribute('aria-valuetext', 'Sans heure');
    await expect(minutes).toHaveAttribute('aria-disabled', 'true');
    await expect(atTime).toHaveAttribute('aria-disabled', 'true');

    // 12 heures = rang 13 (rang 0 : « — »). Le geste traverse 00, 01… sans jamais être ramené en arrière.
    await dragWheel(hours, 13);
    await expect(hours).toHaveAttribute('aria-valuetext', '12 heures');
    await expect(hours.locator('.ct-wheel__viewport')).toHaveJSProperty('scrollTop', 13 * 32);
    await expect(minutes).not.toHaveAttribute('aria-disabled', 'true');
    await dragWheel(minutes, 3);
    await expect(minutes).toHaveAttribute('aria-valuetext', /15/);

    // N-02 : « À l'heure » cochée d'office à la première heure ; une seconde avance se coche.
    await expect(atTime).not.toHaveAttribute('aria-disabled', 'true');
    await expect(atTime).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('checkbox', { name: '30 min' }).click();
    await expect(dialog.getByRole('checkbox', { name: '30 min' })).toHaveAttribute('aria-checked', 'true');
    // La roue des jours n'a pas bougé pendant les gestes sur les autres roues : la tâche est bien celle d'aujourd'hui.
    await expect(dialog.getByRole('spinbutton', { name: 'Jour' })).toHaveAttribute('aria-valuetext', /Aujourd/);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.locator('.ct-list-row', { hasText: 'Rappel au doigt' });
    await expect(row).toContainText('12:15');
    await page.locator('.ct-today__list').getByRole('button', { name: 'Rappel au doigt', exact: true }).click();
    const fiche = page.getByRole('dialog', { name: 'Détail de la tâche' });
    await expect(fiche).toBeVisible();
    await expect(fiche.locator('.ct-task-detail__chip')).toHaveText(['À l’heure', '30 min avant']);
  });

  test('un geste qui s’arrête entre deux rangées se cale sur la plus proche sans revenir en arrière', async ({ page }) => {
    await openToday(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    const hours = dialog.getByRole('spinbutton', { name: 'Heures' });
    const viewport = hours.locator('.ct-wheel__viewport');
    await viewport.evaluate((el) => {
      el.scrollTop = 6 * 32 + 12;
    });
    await expect(hours).toHaveAttribute('aria-valuetext', '5 heures');
    // Aucun recalage programmé : la position est celle du geste (ou celle choisie par scroll-snap), jamais une rangée plus bas ou plus haut.
    const top = await viewport.evaluate((el) => el.scrollTop);
    expect(Math.abs(top - 6 * 32)).toBeLessThanOrEqual(12);
  });
});
