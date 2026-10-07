import { expect, type Page } from '@playwright/test';

/** Délai d'attente du démarrage de l'app : large, car plusieurs agents et workers Playwright tournent en parallèle sur la machine. */
export const APP_READY_TIMEOUT_MS = 30_000;

/**
 * Ouvre l'app et attend qu'elle soit prête (base ouverte, onglets affichés, écrans à la demande arrivés). Point d'entrée commun de
 * toutes les specs. Un bloc qui n'arrive pas ne passe pas inaperçu : le repère est posé aussi après un échec (journalisé), mais l'écran
 * visé affiche alors « Impossible d'afficher cet écran » et l'assertion de la spec échoue.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await waitForScreensLoaded(page);
}

/**
 * Attend que tous les écrans à la demande soient arrivés (repère `data-ct-screens-loaded` de `preloadScreens`). Un test qui ouvre un
 * écran à la demande (rapport, Un jour, Réglages...) tout de suite après le démarrage le demande avant son préchargement : sur un
 * serveur de développement à froid et une machine chargée, le bloc arrive après les 5 s d'une assertion. Attente d'un état, jamais d'un délai.
 */
export async function waitForScreensLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ct-screens-loaded'), undefined, { timeout: APP_READY_TIMEOUT_MS });
}
