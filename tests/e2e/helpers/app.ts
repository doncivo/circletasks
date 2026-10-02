import { expect, type Page } from '@playwright/test';

/** Délai d'attente du démarrage de l'app : large, car plusieurs agents et workers Playwright tournent en parallèle sur la machine. */
export const APP_READY_TIMEOUT_MS = 30_000;

/** Ouvre l'app et attend qu'elle soit prête (base ouverte, onglets affichés). Point d'entrée commun de toutes les specs. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
}
