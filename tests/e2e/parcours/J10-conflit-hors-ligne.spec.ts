import { expect, test, type Page } from '@playwright/test';
import { createTask } from '../helpers/today';
import {
  closeRoom,
  conflictItems,
  failAfter,
  inspect,
  openSyncDetails,
  openSyncedPage,
  openTasks,
  propagate,
  syncNow,
  syncStatusLine,
  taskRow,
  type SyncedPage,
} from '../helpers/sync';

/**
 * Parcours clé 10 (PRD 8 ; Y-02, Y-04, Y-05 ; ADR 0011 §12) : « Modifier la même tâche sur PC et iPhone hors ligne, synchroniser,
 * consulter et restaurer le conflit », sur deux pages du navigateur de dev (PC et iPhone 16 Pro Max) reliées par le simulateur de
 * dossier (`tests/sim/syncFolderSim.ts`) : chaque page a sa base, son dossier iCloud simulé et sa clé ; « iCloud » ne recopie les
 * dossiers que sur ordre du test. Lancé une fois, depuis le projet `pc` (le test ouvre lui-même la page iPhone avec les réglages du
 * projet `iphone`).
 *
 * Y-05 critère 6 (points non prouvés par la QA du lot Y2, critère 13 de Y-04) : pendant la publication de 5 000 opérations, aucune
 * tâche longue de plus de 250 ms (D4, `PerformanceObserver` `longtask`) ; un cycle interrompu à mi-publication reprend où il s'est
 * arrêté (aucune perte, aucun doublon). Mesure marquée @perf : projet `perf`, sans concurrence
 * (`npx playwright test tests/e2e/parcours/J10 --project=perf --no-deps`), avec un budget de durée des cycles.
 */


const PC = { project: { name: 'pc' } };
const TITLE = 'Envoyer la facture';

/** Détail de la tâche : panneau (PC) ou feuille (iPhone). */
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));
const listTitle = (page: Page, name: string) => page.locator('.ct-today__list').getByRole('button', { name, exact: true });

let opened: SyncedPage[] = [];
let room = '';

/**
 * Projet qui lance le test (une seule fois) et budget explicite de sa durée ; espace propre au test dans le simulateur. Le parcours
 * ouvre lui-même ses deux pages depuis le projet `pc` ; la mesure des 5 000 opérations est `@perf` (projet `perf`, sans concurrence).
 */
function start(project: 'pc' | 'perf', budgetMs: number): void {
  const info = test.info();
  test.skip(info.project.name !== project, `lancé une fois, depuis le projet ${project}`);
  test.setTimeout(budgetMs);
  room = `j10-${String(info.workerIndex)}-${info.testId}-${String(info.retry)}`;
}

/**
 * Budget du parcours 10 : deux apps démarrées (bases neuves) et onze cycles de synchro dans un même test. Durée mesurée le 2026-10-06 :
 * 12 à 18 s (projet pc, 2 workers, serveur de dev déjà compilé) ; budget 40 s, un peu plus du double du pire mesuré, au lieu du
 * triplement implicite de `test.slow()`.
 */
const PARCOURS_BUDGET_MS = 40_000;

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

test('parcours 10 : même tâche modifiée hors ligne sur PC et iPhone, conflit dans le journal des deux côtés, « Restaurer », même valeur partout', async ({ browser }) => {
  start('pc', PARCOURS_BUDGET_MS);
  // PC : premier appareil (dossier et clé), synchronisé une fois.
  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await expect(syncStatusLine(pc.page)).toHaveText(/^À jour/);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '08:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);

  // iPhone : associé au PC, reçoit la tâche.
  const iphone = await openSyncedPage(browser, room, 'iphone', 'join');
  opened.push(iphone);
  await openSyncDetails(iphone.page);
  await syncNow(iphone.page);
  await openTasks(iphone.page);
  await expect(taskRow(iphone.page, TITLE)).toContainText('08:00');
  await propagate(room);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);

  // Hors ligne (aucune recopie iCloud) : le PC met 10:00, puis l'iPhone 09:00 ; chacun publie dans son propre dossier.
  await openTasks(pc.page);
  await listTitle(pc.page, TITLE).click();
  await detail(pc.page).getByRole('button', { name: 'Heure : 08:00' }).click();
  await detail(pc.page).getByLabel('Heure').fill('10h00');
  await pc.page.keyboard.press('Enter');
  await expect(taskRow(pc.page, TITLE)).toContainText('10:00');
  await pc.page.keyboard.press('Escape');
  await openSyncDetails(pc.page);
  await syncNow(pc.page);

  await listTitle(iphone.page, TITLE).click();
  await detail(iphone.page).getByRole('button', { name: 'Modifier' }).click();
  const edit = iphone.page.getByRole('dialog', { name: 'Modifier la tâche' });
  const hours = edit.getByRole('spinbutton', { name: 'Heures' });
  await expect(hours).toHaveAttribute('aria-valuetext', '8 heures');
  await hours.focus();
  await iphone.page.keyboard.press('ArrowUp');
  await expect(hours).toHaveAttribute('aria-valuetext', '9 heures');
  await edit.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(edit).toHaveCount(0);
  await detail(iphone.page).getByRole('button', { name: 'Fermer' }).click();
  await expect(taskRow(iphone.page, TITLE)).toContainText('09:00');
  await openSyncDetails(iphone.page);
  await syncNow(iphone.page);

  // Retour en ligne : synchro des deux pages ; l'heure la plus récente (09:00, iPhone) gagne partout.
  await propagate(room);
  await syncNow(pc.page);
  await syncNow(iphone.page);
  await propagate(room);

  // Le même conflit est dans le journal des deux côtés (Synchro.html : « 09:00 gardée · iPhone », « 10:00 écartée · PC »).
  for (const side of [pc, iphone]) {
    await expect(side.page.getByText('1 conflit cette semaine')).toBeVisible();
    await expect(conflictItems(side.page)).toHaveCount(1);
    const item = conflictItems(side.page).first();
    await expect(item).toHaveAccessibleName(`Conflit : ${TITLE}, heure`);
    await expect(item).toContainText(`${TITLE} · heure`);
    await expect(item.locator('.ct-conflicts__value--kept')).toContainText('09:00 gardée');
    await expect(item.locator('.ct-conflicts__value--kept')).toContainText(/iPhone · \d{2}:\d{2}/);
    await expect(item.locator('.ct-conflicts__value--discarded')).toContainText('10:00 écartée');
    await expect(item.locator('.ct-conflicts__value--discarded')).toContainText(/PC · \d{2}:\d{2}/);
  }

  // « Restaurer » sur le PC : valeur écartée remise, annoncée dans la ligne, annulable 5 s.
  const onPc = conflictItems(pc.page).first();
  await onPc.getByRole('button', { name: `Restaurer la valeur écartée : ${TITLE}, heure` }).click();
  await expect(onPc.getByRole('status')).toHaveText(`Valeur restaurée : ${TITLE}, heure`);
  await expect(onPc).toContainText(/Restaurée le \d{1,2} /);
  await expect(onPc).toBeFocused();
  await expect(pc.page.getByText('Valeur restaurée', { exact: true })).toBeVisible();
  await expect(pc.page.getByRole('dialog')).toHaveCount(0);

  // Cycle suivant : l'iPhone a la même valeur et n'inscrit aucun nouveau conflit.
  await syncNow(pc.page);
  await propagate(room);
  await syncNow(iphone.page);
  await propagate(room);
  await syncNow(pc.page);
  await expect(conflictItems(iphone.page)).toHaveCount(1);
  await expect(conflictItems(pc.page)).toHaveCount(1);
  await openTasks(iphone.page);
  await expect(taskRow(iphone.page, TITLE)).toContainText('10:00');
  await openTasks(pc.page);
  await expect(taskRow(pc.page, TITLE)).toContainText('10:00');
});

/**
 * Budget des deux cycles de publication des 5 000 opérations (interrompu puis repris), sans concurrence (projet perf). Mesuré le
 * 2026-10-06 : 4,1 à 5,0 s au total (interrompu ≈ 1,0 s, repris 3,1 à 3,9 s ; dev, SQLite Wasm dans la page) ; budget 10 s, le double du
 * pire mesuré : une régression (mise en forme redevenue quadratique, pauses trop fréquentes) le fait échouer.
 */
const PUBLISH_CYCLE_BUDGET_MS = 10_000;
/** Budget du test entier (démarrage de l'app, insertion des 5 000 tâches, deux cycles) : mesuré 9 à 16 s, budget 40 s. */
const PERF_TEST_BUDGET_MS = 40_000;

/** Insère `count` tâches (identifiants `30000000-…`), datées loin dans le futur, écrites par cet appareil (hlc valides) : file d'envoi. */
async function seedOfflineTasks(page: Page, deviceId: string, count: number): Promise<void> {
  await page.evaluate(
    async ({ deviceId: device, count: n }) => {
      const hooks = (window as unknown as { __ctTest: { execute(sql: string, params?: unknown[]): Promise<void> } }).__ctTest;
      const ms = Date.now();
      const at = new Date(ms).toISOString();
      await hooks.execute(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO task (id, space_id, title, note, date, status, sort_order, created_at, updated_at, device_id, hlc)
         SELECT printf('30000000-0000-4000-8000-%012x', i), '00000000-0000-4000-8000-000000000001', 'Tâche hors ligne ' || (i + 1), ?, '2031-01-06', 'todo', i, ?, ?, ?,
                printf('%015d-%04x-%s', ?, i, ?)
         FROM n`,
        [n - 1, 'x'.repeat(400), at, at, device, ms, device],
      );
    },
    { deviceId, count },
  );
}

test('Y-05 : 5 000 opérations publiées sans tâche longue de plus de 250 ms ; cycle interrompu à mi-publication repris sans perte ni doublon @perf', async ({ browser }) => {
  start('perf', PERF_TEST_BUDGET_MS);
  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  const { page } = pc;
  await openSyncDetails(page);
  await expect(syncStatusLine(page)).toHaveText(/^À jour/);
  const { deviceId } = await inspect(room, 'pc');
  expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
  await seedOfflineTasks(page, String(deviceId), 5_000);

  // Tâches longues de la page pendant les deux cycles (interrompu, puis repris). Sans prise en charge du type `longtask`, la mesure
  // serait vide et le test passerait à vide : on l'exige explicitement.
  expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')), 'le navigateur ne rapporte pas les tâches longues').toBe(true);
  await page.evaluate(() => {
    const durations: number[] = [];
    (window as unknown as { __ctLongTasks: number[] }).__ctLongTasks = durations;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) durations.push(entry.duration);
    }).observe({ type: 'longtask' });
  });

  // Arrêt à mi-publication : le troisième ajout au journal échoue (« io »), avant toute écriture.
  const before = await inspect(room, 'pc');
  await failAfter(room, 'pc', 'appendJournal', 2, 'io');
  const interruptedStart = Date.now();
  await syncNow(page, /^La synchronisation a échoué/);
  const interruptedMs = Date.now() - interruptedStart;
  const partial = await inspect(room, 'pc');
  const seeded = (tasks: Readonly<Record<string, number>>) => Object.entries(tasks).filter(([id]) => id.startsWith('30000000-'));
  // Au moins un ajout a abouti avant la panne (un segment plein ouvre le suivant : un appel de plus, sans ajout).
  expect(partial.appends).toBeGreaterThan(before.appends);
  expect(seeded(partial.tasks).length).toBeGreaterThan(0);
  expect(seeded(partial.tasks).length).toBeLessThan(5_000);

  // Cycle suivant : reprise où il s'est arrêté, chaque tâche publiée une seule fois.
  const resumedStart = Date.now();
  await syncNow(page);
  const resumedMs = Date.now() - resumedStart;
  test.info().annotations.push({ type: 'cycles de publication', description: `interrompu ${String(interruptedMs)} ms, repris ${String(resumedMs)} ms` });
  const done = await inspect(room, 'pc');
  expect(seeded(done.tasks)).toHaveLength(5_000);
  expect(seeded(done.tasks).filter(([, times]) => times !== 1)).toEqual([]);
  expect(done.appends).toBeGreaterThan(partial.appends);

  const longTasks = await page.evaluate(() => (window as unknown as { __ctLongTasks: number[] }).__ctLongTasks);
  expect(longTasks.filter((duration) => duration > 250), `tâches longues : ${JSON.stringify(longTasks.map(Math.round))}`).toEqual([]);
  // Budget de durée des cycles de publication (clic sur « Synchroniser » jusqu'à la fin du cycle), voir PUBLISH_CYCLE_BUDGET_MS.
  expect(interruptedMs + resumedMs, `cycles : ${String(interruptedMs)} + ${String(resumedMs)} ms`).toBeLessThan(PUBLISH_CYCLE_BUDGET_MS);
});
