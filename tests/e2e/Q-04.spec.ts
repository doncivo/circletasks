import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { isPhone, openToday, rowOf } from './helpers/today';

/**
 * Q-04 — scan de tâches : « Scan tâches », choix de l'image, lecture (faux moteur), relecture obligatoire, création en lot annulable.
 * Projets `pc` et `iphone`. Le moteur est un faux (`__CT_FAKE_OCR__`, développement seulement) : la lecture réelle de Windows.Media.Ocr et de
 * tesseract.js est testée par `cargo test` et `tesseractOcr.test.ts` sur les images de tests/fixtures/ocr.
 */
const FIXTURE = resolve('tests/fixtures/ocr/liste-imprimee.png');
const LINES = [{ text: '- Appeler le plombier' }, { text: '- Acheter des ampoules' }, { text: '- resto samedi' }, { text: '- Payer la cantine' }, { text: '- garage ?' }];

async function fake(page: Page, hook: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>)['__CT_FAKE_OCR__'] = value;
  }, hook);
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Scan tâches' });
const fileInput = (page: Page) => dialog(page).getByLabel('Choisir une image');

async function openScan(page: Page): Promise<void> {
  await openToday(page);
  await page.getByRole('button', { name: 'Scan tâches' }).click();
  await expect(dialog(page)).toBeVisible();
}

test.describe('Q-04 — scan de tâches', () => {
  test('« Scan tâches » : à droite du champ sur PC, sous le champ sur iPhone (critère 1)', async ({ page }, testInfo) => {
    await fake(page, { lines: LINES });
    await openToday(page);
    const field = await page.getByLabel('Nouvelle tâche').boundingBox();
    const scan = await page.getByRole('button', { name: 'Scan tâches' }).boundingBox();
    expect(field && scan).toBeTruthy();
    if (isPhone(testInfo)) {
      expect(scan?.y ?? 0).toBeGreaterThan((field?.y ?? 0) + (field?.height ?? 0) - 1);
      expect(scan?.height).toBeGreaterThanOrEqual(40);
    } else {
      expect(scan?.x ?? 0).toBeGreaterThan((field?.x ?? 0) + (field?.width ?? 0) - 1);
      expect(scan?.height).toBe(48);
    }
  });

  test('image -> Lecture en cours -> Relecture : cases, date détectée, ligne incertaine (critères 3, 4, 6, 7)', async ({ page }, testInfo) => {
    await fake(page, { lines: LINES, delayMs: 250 });
    await openScan(page);
    await fileInput(page).setInputFiles(FIXTURE);
    await expect(dialog(page).getByRole('heading', { name: 'Lecture en cours' })).toBeVisible();
    await expect(dialog(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
    await expect(dialog(page).getByText('5 lignes détectées')).toBeVisible();
    await expect(dialog(page).getByRole('textbox', { name: /^Tâche \d$/ })).toHaveCount(5);
    await expect(dialog(page).getByRole('textbox', { name: 'Tâche 1' })).toHaveValue('Appeler le plombier');
    await expect(dialog(page).getByText(/^Date détectée : /)).toHaveCount(1);
    await expect(dialog(page).getByText('Lecture incertaine, à vérifier')).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Ne pas créer cette tâche' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog(page).getByRole('button', { name: 'Créer 4 tâches' })).toBeEnabled();
    // Zones tactiles de 44 pt autour des cases de 26 px (critère 14).
    const check = await dialog(page).getByRole('button', { name: 'Créer cette tâche' }).first().boundingBox();
    expect(check?.width).toBeGreaterThanOrEqual(44);
    expect(check?.height).toBeGreaterThanOrEqual(44);
    if (isPhone(testInfo)) {
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(440);
    }
  });

  test('valider : les tâches cochées sont créées, « 4 tâches créées » avec Annuler, Ctrl+Z retire tout (critères 8 et 9)', async ({ page }, testInfo) => {
    await fake(page, { lines: LINES });
    await openScan(page);
    await fileInput(page).setInputFiles(FIXTURE);
    await dialog(page).getByRole('heading', { name: 'Relecture' }).waitFor();
    // Correction du texte et décochage d'une ligne : le compteur suit.
    await dialog(page).getByRole('textbox', { name: 'Tâche 4' }).fill('Payer la cantine de septembre');
    await dialog(page).getByRole('button', { name: 'Créer cette tâche' }).nth(1).click();
    await expect(dialog(page).getByRole('button', { name: 'Créer 3 tâches' })).toBeEnabled();
    await dialog(page).getByRole('button', { name: 'Ne pas créer cette tâche' }).first().click();
    await expect(dialog(page).getByRole('button', { name: 'Créer 4 tâches' })).toBeEnabled();
    await dialog(page).getByRole('button', { name: 'Créer 4 tâches' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText('4 tâches créées')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeVisible();
    // Aujourd'hui (date par défaut) : les lignes sans date apparaissent ; « resto samedi » est daté de samedi.
    await expect(rowOf(page, 'Appeler le plombier')).toBeVisible();
    await expect(rowOf(page, 'Payer la cantine de septembre')).toBeVisible();
    await expect(rowOf(page, 'resto')).toHaveCount(0);
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    } else {
      await page.keyboard.press('Control+z');
    }
    await expect(rowOf(page, 'Appeler le plombier')).toHaveCount(0);
    await expect(rowOf(page, 'Payer la cantine de septembre')).toHaveCount(0);
  });

  test('image réduite à 2 000 px au plus avant la lecture (critère 3)', async ({ page }) => {
    await fake(page, { lines: LINES });
    await openScan(page);
    const buffer = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 3200;
      canvas.height = 2400;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 3200, 2400);
        context.fillStyle = '#000000';
        context.font = '120px sans-serif';
        context.fillText('Appeler le plombier', 200, 600);
      }
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b as Blob), 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await fileInput(page).setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.from(buffer) });
    await dialog(page).getByRole('heading', { name: 'Relecture' }).waitFor();
    const log = await page.evaluate(() => (window as unknown as { __CT_FAKE_OCR_LOG__: Array<{ width: number; height: number; type: string }> }).__CT_FAKE_OCR_LOG__);
    expect(log).toHaveLength(1);
    expect(log[0]?.width).toBe(2000);
    expect(log[0]?.height).toBe(1500);
    expect(log[0]?.type).toBe('image/png');
  });

  test('HEIC et image trop lourde : message, rien n’est lu (critère 2)', async ({ page }) => {
    await fake(page, { lines: LINES });
    await openScan(page);
    await fileInput(page).setInputFiles({ name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from([1, 2, 3]) });
    await expect(dialog(page).getByRole('alert')).toHaveText('Les photos HEIC ne sont pas lues. Exportez-les en JPEG ou en PNG.');
    await fileInput(page).setInputFiles({ name: 'gros.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await expect(dialog(page).getByRole('alert')).toHaveText('Cette image est trop lourde (10 Mo au plus).');
    await expect(dialog(page).getByRole('heading', { name: 'Votre liste' })).toBeVisible();
  });

  test('image sans texte : « Aucune ligne reconnue », « Reprendre la photo » (critère 12)', async ({ page }) => {
    await fake(page, { lines: [] });
    await openScan(page);
    await fileInput(page).setInputFiles(resolve('tests/fixtures/ocr/page-vide.png'));
    await expect(dialog(page).getByRole('heading', { name: 'Aucune ligne reconnue' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Reprendre la photo' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Votre liste' })).toBeVisible();
  });

  test('fermer après une correction demande confirmation ; rien n’est créé (critère 10)', async ({ page }) => {
    await fake(page, { lines: LINES });
    await openScan(page);
    await fileInput(page).setInputFiles(FIXTURE);
    await dialog(page).getByRole('textbox', { name: 'Tâche 1' }).fill('Appeler le plombier demain');
    await dialog(page).getByRole('button', { name: 'Annuler le scan' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Fermer sans créer ?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Continuer la relecture' }).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Fermer sans créer' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(rowOf(page, 'Appeler le plombier demain')).toHaveCount(0);
  });

  test('pack de langue français absent : marche à suivre, vérification, repli intégré (critère 11)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Moteur du système : PC seulement');
    await fake(page, { lines: LINES, packMissing: true });
    await openScan(page);
    await expect(dialog(page).getByRole('heading', { name: 'Reconnaissance du texte indisponible' })).toBeVisible();
    await expect(dialog(page).getByText('Ouvrez Paramètres Windows › Heure et langue › Langue et région.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Vérifier de nouveau' }).click();
    await expect(dialog(page).getByText('Le pack n’est pas encore détecté. Redémarrez l’application après l’installation.')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Lire quand même avec le moteur intégré' }).click();
    await fileInput(page).setInputFiles(FIXTURE);
    await expect(dialog(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
  });

  test('iPhone, Vision en échec : erreur persistante avec son code, aucun repli silencieux, « Lire avec le moteur intégré » mène à la relecture (CAP-IOS-01 critères 4 et 6)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Vision : iPhone seulement');
    await fake(page, { lines: LINES, vision: { failure: 'failed' } });
    await openScan(page);
    await fileInput(page).setInputFiles(FIXTURE);
    await expect(dialog(page).getByRole('heading', { name: 'La lecture n’a pas abouti' })).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toContainText('Code : ocr-engine');
    await page.waitForTimeout(300);
    await expect(dialog(page).getByRole('heading', { name: 'La lecture n’a pas abouti' })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Lire avec le moteur intégré' }).click();
    await expect(dialog(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
  });

  test('iPhone, Vision indisponible : écran avec son code, repli au choix (CAP-IOS-01 critère 17)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Vision : iPhone seulement');
    await fake(page, { lines: LINES, vision: { unavailable: 'plugin-unavailable' } });
    await openScan(page);
    await expect(dialog(page).getByRole('heading', { name: 'Le moteur de lecture de l’iPhone est indisponible' })).toBeVisible();
    await expect(dialog(page).getByRole('alert')).toContainText('vision-plugin-unavailable');
    await dialog(page).getByRole('button', { name: 'Lire avec le moteur intégré' }).click();
    await fileInput(page).setInputFiles(FIXTURE);
    await expect(dialog(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
  });

  test('glisser-déposer d’une image sur la fenêtre (PC)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'PC seulement');
    await fake(page, { lines: LINES });
    await openScan(page);
    const buffer = (await import('node:fs')).readFileSync(FIXTURE);
    const data = await page.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'liste.png', { type: 'image/png' }));
      return transfer;
    }, Array.from(buffer));
    await dialog(page).dispatchEvent('drop', { dataTransfer: data });
    await expect(dialog(page).getByRole('heading', { name: 'Relecture' })).toBeVisible();
  });
});
