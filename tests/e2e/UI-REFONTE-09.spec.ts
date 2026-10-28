import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * UI-REFONTE-09 — Réglages sur PC (docs/maquettes-refonte/PC-Reglages.html) : sommaire à gauche (huit sections, section courante), colonne
 * de réglages bornée à 660 px, titres de section en minuscules, « Général » en lignes séparées avec la valeur près de son étiquette,
 * « Clavier » avec « Tous les raccourcis · Ctrl / ». Projet `pc`.
 */

const SECTIONS = ['Général', 'Tâches', 'Rappels', 'Espaces et agendas', 'Synchronisation', 'Sauvegardes et données', 'Clavier', 'À propos'];

test.describe('UI-REFONTE-09 — Réglages PC', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'pc', 'Mise en page PC seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : sommaire, colonne bornée, sections en minuscules, Général en lignes séparées, Clavier (critères 1 à 6)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page);
      await page.getByRole('navigation', { name: 'Navigation principale' }).getByText('Réglages', { exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();

      const nav = page.getByRole('group', { name: 'Sections des réglages' });
      await expect(nav.getByRole('button')).toHaveText(SECTIONS);
      await expect(nav.getByRole('button', { name: 'Général' })).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.ct-settings__rule')).toHaveCount(0);

      // Colonne bornée : 660 px au plus ; la valeur reste près de son étiquette.
      const content = page.locator('.ct-settings__content');
      const box = await content.boundingBox();
      expect(box && box.width <= 660).toBeTruthy();
      for (const name of SECTIONS) await expect(content.getByRole('heading', { level: 2, name, exact: true })).toBeAttached();
      await expect(page.getByText('GÉNÉRAL', { exact: true })).toHaveCount(0);

      const general = page.getByRole('region', { name: 'Général' });
      await expect(general.getByRole('button', { name: /^Thème : / })).toBeVisible();
      await expect(general.getByRole('button', { name: /^Début de semaine : / })).toBeVisible();
      await expect(general.getByRole('button', { name: /^Format de l’heure : / })).toBeVisible();
      await expect(general.getByRole('button', { name: /^Onglets visibles : \d+ sur \d+$/ })).toBeVisible();
      await expect(general.getByText('Suit celui de Windows')).toBeVisible();
      await expect(general.getByText('Europe/Paris', { exact: true })).toBeVisible();
      await expect(page.getByText(/\(automatique\)/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Thème · semaine · heure/ })).toHaveCount(0);

      // Sommaire : un clic fait défiler la section en vue et la rend courante ; le sommaire reste visible.
      await nav.getByRole('button', { name: 'À propos' }).click();
      await expect(content.getByRole('heading', { level: 2, name: 'À propos' })).toBeInViewport();
      await expect(nav.getByRole('button', { name: 'À propos' })).toHaveAttribute('aria-current', 'true');
      await expect(nav).toBeInViewport();

      // Clavier : « Tous les raccourcis » avec son raccourci, ligne cliquable.
      const keyboard = page.getByRole('region', { name: 'Clavier' });
      const all = keyboard.getByRole('button', { name: 'Afficher les raccourcis clavier' });
      await expect(all).toContainText('Tous les raccourcis');
      await expect(all).toContainText('Ctrl /');
      await all.click();
      await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible();
    });
  }
});
