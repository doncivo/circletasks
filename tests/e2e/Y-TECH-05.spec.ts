import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { closeRoom, openSyncDetails, openSyncedPage, syncNow, type SyncedPage } from './helpers/sync';

/**
 * Y-TECH-05 (critères 16 à 22 et 26) : compte rendu du changement d'époque vu par l'interface, projets `pc` et `iphone` (écran réduit à
 * 393 pt de large). La base du navigateur de développement est en mémoire : le compte rendu est semé par la prise de test
 * `window.__ctTest.execute` (même mécanisme que les e2e Y-IOS-02 pour leurs états), puis un cycle de synchro réel lève l'avertissement par le
 * moteur. Le redémarrage (base conservée, nouvelle instance de l'app) est couvert par `src/features/sync/carryReportScenario.test.tsx` :
 * une page rechargée repart d'une base vide.
 */

const BUDGET_MS = 90_000;
const BANNER = /Changement d’époque : éléments rétablis : \d+\. Voir le compte rendu/;
const VIEW = 'Voir le problème de synchronisation';
const RESTORED = 'Rétablis alors que vous les aviez supprimés';

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

/** Compte rendu non acquitté avec bandeau : `restored` lignes rétablies dont « À jeter », une recréée « Test Pc ». */
async function seedReport(page: Page, restored: number, overflow = 0): Promise<void> {
  await page.evaluate(
    async ([count, over]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      const me = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const deleted = '2026-10-17T09:30:00.000Z';
      const items = Array.from({ length: count }, (_, i) => ({
        table: 'task',
        rowId: `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
        label: i === 0 ? 'À jeter' : `Tâche ${String(i + 1)}`,
        by: other,
        deletedAt: deleted,
        deletedBy: me,
      }));
      const recreated = [{ table: 'task', rowId: 'ffffffff-0000-4000-8000-000000000000', label: 'Test Pc', by: other, deletedAt: null, deletedBy: null }];
      const authors = [{ device: other, fields: count + 1, rows: count + 1, tombs: 0, late: 0 }];
      await hooks.execute(
        "INSERT INTO epoch_carry_report (epoch, cause, reporter, opener, mode, authors, restored, recreated, parent_replaced, overflow, overflow_by, banner, created_at) VALUES (?, 'restore', ?, ?, 'replace', ?, ?, ?, '[]', ?, ?, 1, ?)",
        ['2-e2e', me, me, JSON.stringify(authors), JSON.stringify(items), JSON.stringify(recreated), over, JSON.stringify({ restored: over, recreated: 0, parentReplaced: 0 }), '2026-10-18T07:00:00.000Z'],
      );
    },
    [restored, overflow] as const,
  );
}

async function start(browser: Parameters<typeof openSyncedPage>[0], kind: 'pc' | 'iphone'): Promise<Page> {
  const info = test.info();
  room = `ytech05-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const synced = await openSyncedPage(browser, room, kind, 'first', kind);
  opened.push(synced);
  // 393 pt : l'iPhone de référence des critères (le projet `iphone` ouvre 440 pt).
  if (kind === 'iphone') await synced.page.setViewportSize({ width: 393, height: 852 });
  await openSyncDetails(synced.page);
  await syncNow(synced.page);
  return synced.page;
}

for (const kind of ['pc', 'iphone'] as const) {
  test(`Y-TECH-05 (${kind}) : bandeau, compte rendu, « J’ai vu » : le bandeau disparaît et ne revient pas au cycle suivant`, async ({ browser }) => {
    test.skip(test.info().project.name !== kind, `projet ${kind} seulement`);
    test.setTimeout(BUDGET_MS);
    const page = await start(browser, kind);
    await seedReport(page, 1);
    await syncNow(page);

    // Critère 16 : bandeau durable avec le nombre d'éléments rétablis (« À jeter » ; « Test Pc », recréée, n'est pas comptée : ADR 0011 §29 point 5).
    const banner = page.locator('.ct-status-banner').filter({ hasText: BANNER });
    await expect(banner).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    await expect(banner).toContainText('éléments rétablis : 1');
    await expectFitsViewport(page, 'Détails de la synchro, bandeau du compte rendu');
    await banner.getByRole('button', { name: VIEW }).click();

    // Critères 17 et 26 : l'écran de détail s'ouvre sur le compte rendu non acquitté.
    const dialog = page.getByRole('dialog', { name: 'Compte rendu du changement d’époque' });
    await expect(dialog).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    await expect(dialog.getByRole('list', { name: `${RESTORED} : 1` }).getByText('À jeter')).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Recréés : 1' }).getByText('Test Pc')).toBeVisible();
    await expect(dialog.getByText(/^Époque du \d+ \S+ 2026 à \d{2}:\d{2}$/)).toBeVisible();
    await expectFitsViewport(page, 'Compte rendu du changement d’époque');

    // Critère 20 : cibles tactiles d'au moins 44 pt, « J'ai vu » en dernier dans l'ordre de focus.
    const buttons = dialog.getByRole('button');
    const names = await buttons.allTextContents();
    expect(names.at(-1)).toBe('J’ai vu');
    for (const button of await buttons.all()) expect((await button.boundingBox())?.height ?? 0, (await button.textContent()) ?? '').toBeGreaterThanOrEqual(44);

    // Critère 18 : « J'ai vu » retire le bandeau tout de suite ; le compte rendu reste lisible.
    await dialog.getByRole('button', { name: 'J’ai vu' }).click();
    await expect(dialog.getByText(/^Vu le /)).toBeVisible();
    await expect(banner).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Compte rendu du changement d’époque : 1' }).getByRole('button', { name: /^Époque du / })).toBeVisible();

    // Il ne revient pas au cycle suivant (le moteur ne lève plus rien).
    await syncNow(page);
    await expect(page.locator('.ct-status-banner').filter({ hasText: BANNER })).toHaveCount(0);
  });

  test(`Y-TECH-05 (${kind}) : 500 lignes nommées : pages de 50, « et 12 autres », défilement sans débordement`, async ({ browser }) => {
    test.skip(test.info().project.name !== kind, `projet ${kind} seulement`);
    test.setTimeout(BUDGET_MS);
    const page = await start(browser, kind);
    await seedReport(page, 500, 12);
    await syncNow(page);
    await page.locator('.ct-status-banner').filter({ hasText: BANNER }).getByRole('button', { name: VIEW }).click();

    const dialog = page.getByRole('dialog', { name: 'Compte rendu du changement d’époque' });
    const list = dialog.getByRole('list', { name: `${RESTORED} : 512` });
    await expect(list).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    // Critère 22 : le premier rendu ne pose que la première page.
    await expect(list.getByRole('listitem')).toHaveCount(50);
    await expect(dialog.getByText(/^et \d+ autres$/)).toHaveCount(0);
    for (let page50 = 2; page50 <= 10; page50 += 1) {
      await dialog.getByRole('button', { name: 'Afficher 50 de plus' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(page50 * 50);
    }
    await expect(dialog.getByRole('button', { name: 'Afficher 50 de plus' })).toHaveCount(0);
    await expect(dialog.getByText('et 12 autres')).toBeVisible();
    await expectFitsViewport(page, 'Compte rendu de 500 lignes');
    // Critère 20 : la feuille défile (le bouton « J'ai vu » est atteint par le défilement).
    await dialog.getByRole('button', { name: 'J’ai vu' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'J’ai vu' })).toBeInViewport();
  });
}
