import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app';
import { isPhone, listTitles, todayTab } from '../helpers/today';

/**
 * Parcours clé 1 (PRD 8) : premier lancement. Base neuve, assistant de bienvenue (P-05), trois étapes (Bienvenue, Espaces, Données
 * d'exemple), « Commencer », arrivée sur Aujourd'hui (A-01) avec les données d'exemple. Le navigateur de développement part d'une
 * base neuve à chaque chargement ; l'assistant n'y est actif que si `globalThis.__ctOnboarding` est posé avant le chargement
 * (crochet de développement, voir P-05.spec.ts). La création du premier espace par défaut (ES-01) est couverte par ES-01.spec.ts.
 */
test('parcours 1 : base neuve, assistant en trois étapes, données d’exemple, arrivée sur Aujourd’hui', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding = true;
  });
  await openApp(page);

  // Étape 1 : Bienvenue. Carte de 640 px sur PC, plein écran sur iPhone.
  const dialog = page.getByRole('dialog', { name: 'Guide de bienvenue' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Étape 1 sur 3')).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1, name: 'Bienvenue' })).toBeFocused();
  const box = await dialog.boundingBox();
  if (isPhone(testInfo)) expect(box?.width).toBeGreaterThanOrEqual(439);
  else expect(Math.round(box?.width ?? 0)).toBe(640);
  await dialog.getByRole('button', { name: 'Continuer' }).click();

  // Étape 2 : Espaces (Pro et Perso).
  await expect(dialog.getByText('Étape 2 sur 3')).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1, name: 'Séparez le pro et le perso' })).toBeFocused();
  await expect(dialog.getByText('ESPACE 1', { exact: true })).toBeVisible();
  await expect(dialog.getByText('ESPACE 2', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Continuer' }).click();

  // Étape 3 : données d'exemple, désactivées par défaut ; on les demande.
  await expect(dialog.getByText('Étape 3 sur 3')).toBeVisible();
  const toggle = dialog.getByRole('switch', { name: 'Ajouter des données d’exemple' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByText('6 tâches, 2 routines, 1 checklist, dans Pro et Perso')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Commencer' }).click();
  await expect(dialog).not.toBeVisible();

  // Arrivée sur Aujourd'hui (A-01) avec les données d'exemple du jour.
  await todayTab(page).click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // Routine d'exemple « Revue de la semaine » : le vendredi seulement (jour de Paris, celui de l'app ; échec constaté un vendredi en CI).
  const friday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Paris' }).format(new Date()) === 'Fri';
  await expect
    .poll(() => listTitles(page))
    .toEqual(['Marcher 20 minutes', 'Préparer la réunion d’équipe', 'Faire les courses', ...(friday ? ['Revue de la semaine'] : []), 'Envoyer la facture du mois']);

  // L'assistant ne revient pas : l'app reste utilisable, la navigation est complète.
  await expect(page.getByRole('navigation')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Guide de bienvenue' })).toHaveCount(0);
});
