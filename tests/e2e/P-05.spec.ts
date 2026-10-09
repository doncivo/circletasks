import { expect, test, type Page } from '@playwright/test';
import { E2E_DEV_PORT } from '../sim/ports';
import { openApp } from './helpers/app';
import { isPhone, listTitles, todayTab } from './helpers/today';

/**
 * P-05 — Je suis guidé au premier lancement. Le navigateur de développement part d'une base neuve à chaque chargement : l'assistant n'y
 * est actif que si le test le demande (`__ctOnboarding`, développement seulement). La reprise après interruption, la détection d'une base
 * qui contient des données et la persistance des choix sont couvertes par `onboarding.test.tsx` (la base du navigateur est en mémoire).
 * Exécuté sur `pc` (carte centrée de 640 px, croix, Échap) et `iphone` (plein écran).
 */
async function openFirstLaunch(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.addInitScript(() => {
    (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding = true;
  });
  await openApp(page);
  const dialog = page.getByRole('dialog', { name: 'Guide de bienvenue' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

test.describe('P-05 — premier lancement', () => {
  test('critères 1 et 12 : carte de 640 px sur PC, plein écran sur iPhone ; étape 1 sur 3, titre h1 avec le focus', async ({ page }, testInfo) => {
    const dialog = await openFirstLaunch(page);
    const box = await dialog.boundingBox();
    if (isPhone(testInfo)) {
      expect(box?.width).toBeGreaterThanOrEqual(439);
      expect(box?.height).toBeGreaterThanOrEqual(900);
    } else {
      expect(Math.round(box?.width ?? 0)).toBe(640);
      await expect(dialog.getByRole('button', { name: 'Fermer le guide de bienvenue' })).toBeVisible();
    }
    await expect(dialog.getByText('Étape 1 sur 3')).toBeVisible();
    const title = dialog.getByRole('heading', { level: 1, name: 'Bienvenue' });
    await expect(title).toBeFocused();
    await expect(dialog.getByText('Ensuite : espaces, puis données d’exemple')).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  test('critère 3 : langue Français non modifiable, premier jour de semaine appliqué tout de suite à la Semaine', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await expect(dialog.getByText('Français')).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Lundi' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Dimanche' }).click();
    await expect(dialog.getByRole('radio', { name: 'Dimanche' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Passer le guide de bienvenue' }).click();
    await expect(dialog).not.toBeVisible();
    await tab(page, 'Semaine').click();
    const first = page.locator('.ct-week-day').first();
    await expect(first).toBeVisible();
    const date = await first.getAttribute('data-date');
    expect(new Date(`${date ?? ''}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  test('critères 2 et 4 : étape Espaces (cartes, renommer, silence), Retour sans perte', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await expect(dialog.getByRole('heading', { level: 1, name: 'Séparez le pro et le perso' })).toBeFocused();
    await expect(dialog.getByText('Étape 2 sur 3')).toBeVisible();
    await expect(dialog.getByText('ESPACE 1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('ESPACE 2', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/^Silence : /)).toBeVisible();
    await expect(dialog.getByText('Aucune plage de silence')).toBeVisible();
    await expect(dialog.getByText('Ensuite : données d’exemple')).toBeVisible();
    const name = dialog.getByLabel('Nom de l’espace 2');
    await name.fill('Maison');
    await name.press('Enter');
    await dialog.getByRole('button', { name: 'Retour' }).click();
    await expect(dialog.getByRole('heading', { level: 1, name: 'Bienvenue' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await expect(dialog.getByLabel('Nom de l’espace 2')).toHaveValue('Maison');
  });

  test('critère 4 : le lien « modifiable » ouvre l’éditeur du silence, l’assistant revient au retour', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await dialog.getByRole('button', { name: /Modifier le silence de l’espace Pro/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /Silence/ })).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Étape 2 sur 3')).toBeVisible();
  });

  test('critères 5 et 6 : données d’exemple désactivées par défaut ; « Commencer » les crée, puis « Supprimer les données d’exemple »', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await expect(dialog.getByText('Étape 3 sur 3')).toBeVisible();
    const toggle = dialog.getByRole('switch', { name: 'Ajouter des données d’exemple' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByText('6 tâches, 2 routines, 1 checklist, dans Pro et Perso')).toBeVisible();
    await expect(dialog.getByText(/Ensuite/)).toHaveCount(0);
    await toggle.click();
    await dialog.getByRole('button', { name: 'Commencer' }).click();
    await expect(dialog).not.toBeVisible();
    await todayTab(page).click();
    // Routine d'exemple « Revue de la semaine » : le vendredi seulement (jour de Paris, celui de l'app ; échec constaté un vendredi en CI).
    const friday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Paris' }).format(new Date()) === 'Fri';
    await expect
      .poll(() => listTitles(page))
      .toEqual(['Marcher 20 minutes', 'Préparer la réunion d’équipe', 'Faire les courses', ...(friday ? ['Revue de la semaine'] : []), 'Envoyer la facture du mois']);
    await tab(page, 'Réglages').click();
    await page.getByRole('button', { name: 'Supprimer les données d’exemple' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Supprimer les données d’exemple ?' });
    await expect(confirm.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByText('Données d’exemple supprimées')).toBeVisible();
    await todayTab(page).click();
    await expect.poll(() => listTitles(page)).toEqual([]);
  });

  test('critère 6 : « Commencer » sans l’option ne crée rien', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await dialog.getByRole('button', { name: 'Commencer' }).click();
    await expect(dialog).not.toBeVisible();
    await todayTab(page).click();
    await expect.poll(() => listTitles(page)).toEqual([]);
    await tab(page, 'Réglages').click();
    await expect(page.getByRole('button', { name: 'Supprimer les données d’exemple' })).toHaveCount(0);
  });

  test('critères 7 et 8 : « Passer » ferme l’assistant ; « Revoir le guide de bienvenue » (À PROPOS) le relance', async ({ page }) => {
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Passer le guide de bienvenue' }).click();
    await expect(dialog).not.toBeVisible();
    await tab(page, 'Réglages').click();
    await expect(page.getByRole('heading', { name: 'À PROPOS' })).toBeVisible();
    await page.getByRole('button', { name: 'Revoir le guide de bienvenue' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Étape 1 sur 3')).toBeVisible();
  });

  test('critères 7 et 9 (PC) : Échap et la croix ferment ; clavier : Tab puis Entrée avancent', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'pas de clavier ni de croix sur iPhone');
    const dialog = await openFirstLaunch(page);
    // Clavier seul : Tab jusqu’à « Continuer », Entrée.
    const next = dialog.getByRole('button', { name: 'Continuer' });
    for (let i = 0; i < 10 && !(await next.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
    await expect(next).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Étape 2 sur 3')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('critère 9 : thème sombre respecté', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const dialog = await openFirstLaunch(page);
    const background = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe('rgb(28, 22, 48)');
  });

  test('critère 11 : aucune demande de compte, de réseau ni de permission', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(`http://localhost:${String(E2E_DEV_PORT)}`)) requests.push(request.url());
    });
    const dialog = await openFirstLaunch(page);
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await expect(dialog.getByText(/compte|notification|autoriser/i)).toHaveCount(0);
    expect(requests.filter((url) => !url.startsWith('data:') && !url.startsWith('blob:'))).toEqual([]);
  });
});
