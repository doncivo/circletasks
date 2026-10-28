import { expect, test, type Page } from '@playwright/test';
import { expectFitsViewport } from './helpers/layout';
import { closeRoom, openSyncDetails, openSyncedPage, syncNow, type SyncedPage } from './helpers/sync';

/**
 * UI-REFONTE-04 — Réglages › Synchronisation (docs/maquettes-refonte/Synchro-v4.html), appareil relié au simulateur de dossier (premier
 * appareil, un cycle réussi) : retour texte « Réglages », carte d'état verte seulement après un cycle complet, titres de section en bas de
 * casse, aucun identifiant complet, pastille « Actif » de cet appareil, largeur de l'iPhone respectée, thème sombre. Les appareils multiples,
 * les conflits et la réinitialisation sont couverts par les tests DOM (`SyncRefonte.test.tsx`). Projets `pc`, `iphone`, `iphone-webkit`.
 */

const kind = (): 'pc' | 'iphone' => (test.info().project.name.startsWith('iphone') ? 'iphone' : 'pc');

test.describe('UI-REFONTE-04 — écran Synchronisation', () => {
  let synced: SyncedPage | null = null;
  let room = '';
  test.afterEach(async () => {
    await synced?.context.close();
    synced = null;
    if (room) await closeRoom(room);
    room = '';
  });

  async function open(browser: Parameters<typeof openSyncedPage>[0], scheme: 'light' | 'dark'): Promise<Page> {
    const info = test.info();
    room = `uirefonte04-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
    synced = await openSyncedPage(browser, room, kind(), 'first', kind(), (page) => page.emulateMedia({ colorScheme: scheme }));
    await openSyncDetails(synced.page);
    return synced.page;
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : retour « Réglages », carte d'état verte après un cycle complet, titres en bas de casse, pastille « Actif » (critères 1 à 4)`, async ({ browser }) => {
      const page = await open(browser, scheme);
      const back = page.getByRole('button', { name: 'Retour à Réglages' });
      await expect(back).toBeVisible();
      await expect(back).toHaveText(/Réglages$/);
      const card = page.locator('.ct-sync__stateCard');
      await expect(card).toBeVisible();
      await expect(card.locator('[data-testid="sync-status-text"]')).toBeVisible();
      // Un cycle complet : la carte passe au vert (règle 5 : le vert ne vient qu'avec « À jour »).
      await syncNow(page);
      await expect(card).toHaveAttribute('data-tone', 'success');
      await expect(card.locator('[data-testid="sync-status-text"]')).toHaveText(/^À jour/);
      const border = await card.evaluate((node) => getComputedStyle(node).borderTopWidth);
      expect(parseFloat(border)).toBeGreaterThanOrEqual(1.5);

      await expect(page.locator('.ct-sync').getByRole('heading', { level: 2, name: 'ÉTAT' })).toHaveCount(0);
      const headings = await page.locator('.ct-sync h2').allTextContents();
      expect(headings).toContain('Appareils');
      expect(headings).toContain('Conflits de cette semaine');
      expect(headings).toContain('Repartir de zéro');
      for (const heading of headings) expect(heading, 'titre en capitales').not.toMatch(/^[A-ZÉÈÀÂÊÎÔÛÇ’' ]{4,}$/);

      // Cet appareil : pastille « Actif » verte, « Cet appareil », aucun identifiant complet à l'écran.
      const self = page.locator('.ct-sync__devices > li').first();
      await expect(self).toContainText('Cet appareil');
      await expect(self.locator('.ct-sync__deviceState')).toHaveText('Actif');
      await expect(self.locator('.ct-sync__deviceState')).toHaveAttribute('data-tone', 'success');
      await expect(page.locator('.ct-sync')).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
      // Repartir de zéro : bloc qui annonce le coût, bouton au trait pleine largeur.
      await expect(page.locator('.ct-sync__resetCard')).toContainText('Vos tâches ne sont pas supprimées.');
      await expect(page.locator('.ct-sync__resetCard').getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeVisible();
      if (kind() === 'iphone') await expectFitsViewport(page, `Synchronisation (${scheme})`);
    });
  }

  test('le bouton « Réglages » ramène à l’accueil de Réglages (critère 1)', async ({ browser }) => {
    const page = await open(browser, 'light');
    await page.getByRole('button', { name: 'Retour à Réglages' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible();
  });
});
