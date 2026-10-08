import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, isPhone } from './helpers/today';

/**
 * I-03 — Je protège l'app par Face ID (critère 12).
 *
 * Projet `iphone` : biométrie injectée en développement seulement (`__ctBiometricFake`, le faux testé de src/platform/biometric), horloge
 * Playwright (retour après 31 s simulées), visibilité du document pilotée par le test. Activation avec authentification, cache posé au
 * passage en arrière-plan, verrou au retour après 31 s (contenu masqué et inerte), échec puis réussite du déverrouillage, retour sous
 * 30 s sans demande. Le verrou au lancement à froid est vérifié en Vitest (AppLockGate.test.tsx) : la base du navigateur de
 * développement est en mémoire, un rechargement repart d'une base vide. Projet `pc` : section absente, aucun verrou.
 */
declare global {
  interface Window {
    __ctVisibility?: DocumentVisibilityState;
    __ctBiometric?: {
      enqueue(...results: string[]): void;
      authenticateCount(): number;
      calls: { type: string; reason?: string }[];
    };
  }
}

const NOW = new Date('2026-10-08T09:00:00+02:00');
const TITLE = 'Préparer le dossier fiscal';

async function setVisibility(page: Page, state: DocumentVisibilityState): Promise<void> {
  await page.evaluate((next) => {
    window.__ctVisibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

test.describe('I-03 — verrouillage Face ID (iPhone, biométrie injectée)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La biométrie injectée représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctBiometricFake?: boolean }).__ctBiometricFake = true;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__ctVisibility ?? 'visible' });
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
  });

  test('activation avec authentification, verrou après 31 s, échec puis réussite, retour sous 30 s sans demande', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE });
    await openSettings(page);
    const toggle = page.getByRole('switch', { name: 'Verrouillage Face ID' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Activation refusée (annulation) : réglage inchangé, message visible.
    await page.evaluate(() => window.__ctBiometric?.enqueue('user-cancel'));
    await toggle.click();
    await expect(page.getByRole('alert')).toContainText('Le verrouillage n’a pas été activé');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Activation réussie : une authentification demandée d'abord.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => window.__ctBiometric?.calls.filter((call) => call.type === 'authenticate').map((call) => call.reason))).toEqual([
      'Activer le verrouillage de CircleTasks',
      'Activer le verrouillage de CircleTasks',
    ]);

    // Retour sous 30 s : cache posé puis retiré, aucune demande.
    await setVisibility(page, 'hidden');
    await expect(page.locator('html')).toHaveAttribute('data-privacy', 'on');
    await page.clock.fastForward(20_000);
    await setVisibility(page, 'visible');
    await expect(page.locator('html')).not.toHaveAttribute('data-privacy', 'on');
    await expect(toggle).toBeVisible();
    expect(await page.evaluate(() => window.__ctBiometric?.authenticateCount())).toBe(2);

    // Retour après 31 s : verrou ; l'authentification automatique échoue (annulée), l'écran reste.
    await setVisibility(page, 'hidden');
    await page.clock.fastForward(31_000);
    await page.evaluate(() => window.__ctBiometric?.enqueue('user-cancel', 'authentication-failed'));
    await setVisibility(page, 'visible');
    await expect(page.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Déverrouillage annulé');
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeHidden();
    await expect(page.getByRole('navigation')).toBeHidden();

    // Échec, puis réussite : l'écran précédent (Réglages) est retrouvé.
    const unlock = page.getByRole('button', { name: 'Déverrouiller CircleTasks' });
    await unlock.click();
    await expect(page.getByRole('alert')).toHaveText('Déverrouillage impossible (authentication-failed)');
    await unlock.click();
    await expect(page.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '');

    // La tâche est toujours là (le verrou couvre l'interface, pas les données).
    await page.getByRole('navigation').getByText('Tâches', { exact: true }).click();
    await expect(page.getByText(TITLE)).toBeVisible();
  });

  test('aucun code sur l’iPhone : « Désactiver le verrouillage » puis la confirmation, touchée par un vrai clic (revue H1)', async ({ page }) => {
    await openSettings(page);
    const toggle = page.getByRole('switch', { name: 'Verrouillage Face ID' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await setVisibility(page, 'hidden');
    await page.clock.fastForward(31_000);
    await page.evaluate(() => window.__ctBiometric?.enqueue('passcode-not-set'));
    await setVisibility(page, 'visible');
    await expect(page.getByRole('alert')).toHaveText('Déverrouillage impossible : aucun code n’est défini sur l’iPhone');
    await page.getByRole('button', { name: 'Désactiver le verrouillage' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Désactiver le verrouillage ?' });
    await expect(dialog).toContainText('Les données de CircleTasks seront de nouveau lisibles sans protection');
    // Vrai clic : Playwright échoue si un autre élément (l'écran de verrou) intercepte le pointeur.
    await dialog.getByRole('button', { name: 'Désactiver', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Verrouillage Face ID' })).toHaveAttribute('aria-checked', 'false');
  });

  test('désactivation : authentification exigée ; ensuite, plus aucun verrou', async ({ page }) => {
    await openSettings(page);
    const toggle = page.getByRole('switch', { name: 'Verrouillage Face ID' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.evaluate(() => window.__ctBiometric?.enqueue('authentication-failed'));
    await toggle.click();
    await expect(page.getByRole('alert')).toContainText('Le verrouillage n’a pas été désactivé');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await setVisibility(page, 'hidden');
    await expect(page.locator('html')).not.toHaveAttribute('data-privacy', 'on');
    await page.clock.fastForward(120_000);
    await setVisibility(page, 'visible');
    await expect(page.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toHaveCount(0);
  });
});

test.describe('I-03 — PC : aucune section, aucun verrou', () => {
  test('section Sécurité absente, retour après 2 min sans verrou', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Projet pc seulement.');
    await page.clock.install({ time: NOW });
    await openApp(page);
    await openSettings(page);
    await expect(page.getByRole('switch', { name: /Verrouillage/ })).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(120_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  });
});
