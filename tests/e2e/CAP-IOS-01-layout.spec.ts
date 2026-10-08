import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { isPhone, openToday } from './helpers/today';

/**
 * CAP-IOS-01 et I-05 — écrans de la capture sur iPhone (440 x 956) : aucun défilement horizontal, et chaque état d'échec offre une action
 * utile (Réessayer, Ouvrir les réglages, Lire avec le moteur intégré). Faux Speech (`__ctSpeech`) et faux OCR (`__CT_FAKE_OCR__`).
 */
const FIXTURE = resolve('tests/fixtures/ocr/liste-imprimee.png');
const LINES = [{ text: '- Appeler le plombier' }, { text: '- garage ?' }];

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(overflow.scroll, `scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`).toBeLessThanOrEqual(overflow.client);
}

async function injectSpeech(page: Page, state: { microphone: string; speechRecognition: string }, onDevice = true): Promise<void> {
  await page.addInitScript(
    ({ initial, ready }) => {
      (window as unknown as Record<string, unknown>)['__ctSpeech'] = {
        isAvailable: () => Promise.resolve(true),
        permissions: () => Promise.resolve({ ...initial }),
        requestPermissions: () => Promise.resolve({ microphone: 'granted', speechRecognition: 'granted' }),
        onDeviceReady: () => Promise.resolve(ready),
        listen: () => new Promise<string>(() => undefined),
      };
    },
    { initial: state, ready: onDevice },
  );
  await injectSettings(page);
}

async function injectSettings(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__ctSystemSettings'] = { openApp: () => Promise.resolve() };
  });
}

async function fakeOcr(page: Page, hook: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>)['__CT_FAKE_OCR__'] = value;
  }, hook);
}

const scan = (page: Page) => page.getByRole('dialog', { name: 'Scan tâches' });

test.describe('CAP-IOS-01 / I-05 — écrans iPhone', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
  });

  test('dictée : explication, refus, modèle hors ligne absent — sans défilement horizontal, avec une action utile', async ({ page }) => {
    await injectSpeech(page, { microphone: 'prompt', speechRecognition: 'prompt' });
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    const explain = page.getByRole('dialog', { name: 'Dicter une tâche' });
    await expect(explain.getByRole('button', { name: 'Continuer' })).toBeVisible();
    await expect(explain.getByRole('button', { name: 'Pas maintenant' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('dictée restreinte (Temps d’écran) : la cause est dite, aucun bouton inutile, sans défilement horizontal', async ({ page }) => {
    await injectSpeech(page, { microphone: 'restricted', speechRecognition: 'granted' });
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(page.getByRole('alert')).toContainText('Temps d’écran');
    await expect(page.getByRole('button', { name: 'Ouvrir les réglages' })).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('service de dictée absent : mention « Dictée indisponible » avec son code, sans défilement horizontal', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__ctSpeech'] = {
        isAvailable: () => Promise.resolve(false),
        availability: () => Promise.resolve({ available: false, code: 'speech-plugin-unavailable' }),
        listen: () => Promise.reject(new Error('absent')),
      };
    });
    await openToday(page);
    await expect(page.getByText(/Dictée indisponible sur cet iPhone.*Code : speech-plugin-unavailable/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dicter' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByText(/Dictée indisponible sur cet iPhone/)).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('dictée refusée : « Ouvrir les réglages » offert, sans défilement horizontal', async ({ page }) => {
    await injectSpeech(page, { microphone: 'denied', speechRecognition: 'denied' });
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(page.getByRole('alert').getByRole('button', { name: 'Ouvrir les réglages' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('modèle hors ligne absent : message persistant (le micro du clavier reste la voie de secours), sans défilement horizontal', async ({ page }) => {
    await injectSpeech(page, { microphone: 'granted', speechRecognition: 'granted' }, false);
    await openToday(page);
    await page.getByRole('button', { name: 'Dicter' }).click();
    await expect(page.getByRole('alert')).toContainText('Le micro du clavier reste utilisable');
    await noHorizontalScroll(page);
  });

  test('scan : source avec indication de la caméra et « Ouvrir les réglages », sans défilement horizontal', async ({ page }) => {
    await injectSpeech(page, { microphone: 'granted', speechRecognition: 'granted' });
    await fakeOcr(page, { lines: LINES });
    await injectSettings(page);
    await openToday(page);
    await page.getByRole('button', { name: 'Scan tâches' }).click();
    await expect(scan(page).getByRole('button', { name: 'Ouvrir les réglages' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('scan : lecture refusée = Réessayer et Lire avec le moteur intégré, sans défilement horizontal', async ({ page }) => {
    await fakeOcr(page, { lines: LINES, vision: { failure: 'failed' } });
    await openToday(page);
    await page.getByRole('button', { name: 'Scan tâches' }).click();
    await scan(page).getByLabel('Choisir une image').setInputFiles(FIXTURE);
    await expect(scan(page).getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await expect(scan(page).getByRole('button', { name: 'Lire avec le moteur intégré' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('scan : moteur indisponible = Lire avec le moteur intégré, sans défilement horizontal', async ({ page }) => {
    await fakeOcr(page, { lines: LINES, vision: { unavailable: 'language-missing' } });
    await openToday(page);
    await page.getByRole('button', { name: 'Scan tâches' }).click();
    await expect(scan(page).getByRole('button', { name: 'Lire avec le moteur intégré' })).toBeVisible();
    await expect(scan(page).getByRole('button', { name: 'Vérifier de nouveau' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('scan : relecture des lignes Vision (ligne incertaine) sans défilement horizontal', async ({ page }) => {
    await fakeOcr(page, { lines: LINES, vision: { lines: [{ text: '- Appeler le plombier', confidence: 95 }, { text: '- garage ?', confidence: 40 }] } });
    await openToday(page);
    await page.getByRole('button', { name: 'Scan tâches' }).click();
    await scan(page).getByLabel('Choisir une image').setInputFiles(FIXTURE);
    await expect(scan(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
    await noHorizontalScroll(page);
  });
});
