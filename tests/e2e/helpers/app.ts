import { expect, type Page } from '@playwright/test';
import { SCREEN_LOADED_PREFIX, type ScreenName } from '../../../src/features/app/screenNames';
import { HOLIDAYS_OFF_SQL } from './events';

/** Délai d'attente du démarrage de l'app : large, car plusieurs agents et workers Playwright tournent en parallèle sur la machine. */
export const APP_READY_TIMEOUT_MS = 30_000;

/**
 * Ouvre l'app et attend qu'elle soit prête (base ouverte, onglets affichés). Point d'entrée commun de toutes les specs.
 * Jours fériés désactivés par défaut (prise de test `__ctSeedSql` du démarrage) : la suite ne dépend pas du calendrier réel (fête de
 * l'Évacuation du 15 octobre 2026 : dix-huit tests d'état vide ou de liste rouges). Les specs des fériés passent `{ holidays: true }`.
 */
export async function openApp(page: Page, options: { readonly holidays?: boolean } = {}): Promise<void> {
  if (!options.holidays) {
    await page.addInitScript((sql: string) => {
      (globalThis as { __ctSeedSql?: readonly string[] }).__ctSeedSql = [sql];
    }, HOLIDAYS_OFF_SQL);
  }
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
}

/**
 * Attend que le bloc d'UN écran à la demande soit arrivé (repère `SCREEN_LOADED_PREFIX + nom` de `lazyScreen`, noms dans `ScreenName`).
 * Un test qui ouvre cet écran tout de suite après le démarrage le demande avant son préchargement : sur un serveur de développement à
 * froid et une machine chargée, le bloc arrive après les 5 s d'une assertion. Attente d'un état, jamais d'un délai. Le repère est posé
 * aussi après un échec (journalisé) : l'écran affiche alors l'erreur et l'assertion de la spec échoue, rien n'est masqué.
 */
export async function waitForScreenLoaded(page: Page, name: ScreenName): Promise<void> {
  const attribute = SCREEN_LOADED_PREFIX + name;
  await expect
    .poll(() => page.evaluate((a) => document.documentElement.hasAttribute(a), attribute), {
      message: `bloc ${name} jamais chargé (préchargement des écrans à la demande ?)`,
      timeout: APP_READY_TIMEOUT_MS,
    })
    .toBe(true);
}
