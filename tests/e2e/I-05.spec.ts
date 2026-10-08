import { expect, test, type Page } from '@playwright/test';
import { isPhone, openToday } from './helpers/today';

/**
 * I-05 — autorisations au bon moment (micro et reconnaissance vocale de la dictée) et CAP-IOS-01 (dictée sur l'appareil).
 * Projet `iphone` avec un faux Speech injecté en développement (`globalThis.__ctSpeech`, retiré du build) ; projet `pc` : aucune feuille
 * d'explication ni bouton de réglages (Win + H inchangé).
 */
async function injectSpeech(page: Page, state: { microphone: string; speechRecognition: string }, options: { onDevice?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ initial, onDevice }) => {
      const calls: string[] = [];
      const fake = {
        calls,
        state: { ...initial },
        isAvailable: () => Promise.resolve(true),
        permissions: () => Promise.resolve({ ...fake.state }),
        requestPermissions: () => {
          calls.push('requestPermissions');
          fake.state = { microphone: 'granted', speechRecognition: 'granted' };
          return Promise.resolve({ ...fake.state });
        },
        onDeviceReady: () => Promise.resolve(onDevice),
        openSettings: () => {
          calls.push('openSettings');
          return Promise.resolve();
        },
        listen: (options: { stopSignal?: AbortSignal }) => {
          calls.push('listen');
          return new Promise<string>((resolve) => {
            options.stopSignal?.addEventListener('abort', () => resolve('Appeler le plombier demain 9 h'), { once: true });
          });
        },
      };
      (window as unknown as Record<string, unknown>)['__ctSpeech'] = fake;
    },
    { initial: state, onDevice: options.onDevice ?? true },
  );
}

const calls = (page: Page): Promise<string[]> => page.evaluate(() => [...((window as unknown as { __ctSpeech: { calls: string[] } }).__ctSpeech.calls)]);

test.describe('I-05 — autorisations de la dictée', () => {
  test('iPhone : première dictée = explication, « Continuer », dictée ; rien n’est créé (critères 1 et 11)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
    await injectSpeech(page, { microphone: 'prompt', speechRecognition: 'prompt' });
    await openToday(page);
    await page.waitForTimeout(300);
    expect(await calls(page)).toEqual([]);
    await page.getByRole('button', { name: 'Dicter' }).click();
    const explain = page.getByRole('dialog', { name: 'Dicter une tâche' });
    await expect(explain).toBeVisible();
    await expect(explain).toContainText('Rien n’est enregistré ni envoyé');
    expect(await calls(page)).toEqual([]);
    await explain.getByRole('button', { name: 'Continuer' }).click();
    const listening = page.getByRole('dialog', { name: 'Je vous écoute' });
    await expect(listening).toBeVisible();
    await listening.getByRole('button', { name: 'Terminer' }).click();
    await expect(page.getByLabel('Nouvelle tâche')).toHaveValue('Appeler le plombier demain 9 h');
    expect(await calls(page)).toEqual(['requestPermissions', 'listen']);
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-today__list .ct-list-row')).toHaveCount(0);
  });

  test('iPhone : refus simulé = message persistant et « Ouvrir les réglages » ; retour avec autorisation rendue = message disparu (critères 3, 4, 11)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
    await injectSpeech(page, { microphone: 'denied', speechRecognition: 'prompt' });
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Le micro est refusé');
    // Rouvrir le message ne relance aucune demande.
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(alert).toContainText('Le micro est refusé');
    await alert.getByRole('button', { name: 'Ouvrir les réglages' }).click();
    await expect.poll(() => calls(page)).toContain('openSettings');
    expect(await calls(page)).not.toContain('requestPermissions');
    // Retour au premier plan avec l'autorisation rendue.
    await page.evaluate(() => {
      const speech = (window as unknown as { __ctSpeech: { state: Record<string, string> } }).__ctSpeech;
      speech.state = { microphone: 'granted', speechRecognition: 'granted' };
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('iPhone : modèle hors ligne absent = message persistant, aucune écoute tentée (CAP-IOS-01 critère 12)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
    await injectSpeech(page, { microphone: 'granted', speechRecognition: 'granted' }, { onDevice: false });
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(page.getByRole('alert')).toContainText('La dictée hors ligne en français n’est pas disponible sur cet iPhone');
    expect(await calls(page)).toEqual([]);
  });

  test('PC : aucune feuille d’explication ni bouton de réglages, aide Win + H inchangée (critère 11)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'PC seulement');
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(page.getByText('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Dicter une tâche' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ouvrir les réglages' })).toHaveCount(0);
  });
});
