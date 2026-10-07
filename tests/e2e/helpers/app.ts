import { expect, type Page } from '@playwright/test';

/** Délai d'attente du démarrage de l'app : large, car plusieurs agents et workers Playwright tournent en parallèle sur la machine. */
export const APP_READY_TIMEOUT_MS = 30_000;

/** Ouvre l'app et attend qu'elle soit prête (base ouverte, onglets affichés). Point d'entrée commun de toutes les specs. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
}

/**
 * Attend que le bloc d'UN écran à la demande soit arrivé (repère `data-ct-loaded-<nom>` de `lazyScreen`, nom de l'export en minuscules).
 * Un test qui ouvre cet écran tout de suite après le démarrage le demande avant son préchargement : sur un serveur de développement à
 * froid et une machine chargée, le bloc arrive après les 5 s d'une assertion. Attente d'un état, jamais d'un délai. Le repère est posé
 * aussi après un échec (journalisé) : l'écran affiche alors l'erreur et l'assertion de la spec échoue, rien n'est masqué.
 */
export async function waitForScreenLoaded(page: Page, name: string): Promise<void> {
  await page.waitForFunction((attribute) => document.documentElement.hasAttribute(attribute), `data-ct-loaded-${name}`, { timeout: APP_READY_TIMEOUT_MS });
}
