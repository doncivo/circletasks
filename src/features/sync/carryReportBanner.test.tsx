// Y-TECH-05, critères 14, 16, 18 et 19 : bandeau durable du compte rendu du changement d'époque, ligne et historique de Détails,
// « J'ai vu » (ce seul compte rendu), échec d'enregistrement visible. Base réelle (SQLite Wasm), faux service de synchro dont l'état porte
// l'avertissement `carry-report` que le moteur lève (le moteur réel est exercé par `carryReportScenario.test.tsx`).
import { act, cleanup, fireEvent, render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { EpochCarryReportBody, EpochCarryReportHead } from '../../domain/sync/epochCarryReport';
import { EPOCH_CARRY_REPORT_FAILED_META } from '../../domain/sync/epochCarryReportView';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { carryReportRaised } from '../../sync/epochCarryReportBanner';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { startSyncIntegration, type SyncIntegration } from './startSync';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f5');
const OTHER = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f6');
const NOW = '2026-10-18T08:02:00.000Z' as IsoDateTime;
const NO_TIMERS = { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined } as const;
const SLOTS = { pairing: null, conflicts: null, version: null, forget: null, reset: null } as const;

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;
let integration: SyncIntegration | null = null;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-18T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  integration?.dispose();
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

const head = (epoch: string, createdAt: string): EpochCarryReportHead => ({ epoch, cause: 'restore', reporter: SELF, opener: OTHER, mode: 'replace', createdAt: createdAt as IsoDateTime });
const body = (labels: readonly string[]): EpochCarryReportBody => ({
  authors: [{ device: OTHER, fields: labels.length, rows: labels.length, tombs: 0, late: 0 }],
  restored: labels.map((label, i) => ({ table: 'task', rowId: `${label}-${String(i)}`, label, by: OTHER, deletedAt: '2026-10-17T09:30:00.000Z' as IsoDateTime, deletedBy: SELF })),
  recreated: [],
  parentReplaced: [],
  overflow: 0,
  overflowBy: { restored: 0, recreated: 0, parentReplaced: 0 },
});

/** Compte rendu non acquitté dont aucune ligne n'est rétablie : `recreated` recréées, `parent` rattachées, `overflow` en débordement (recréées). */
async function seedOthers(epoch: string, createdAt: string, recreated: number, parent: number, overflow = 0): Promise<number> {
  const reports = await db.data.repos.carryReports();
  const id = await reports.create(head(epoch, createdAt));
  const base = body([]);
  await reports.save(
    id,
    {
      ...base,
      authors: [{ device: OTHER, fields: recreated + parent, rows: recreated + parent, tombs: 0, late: 0 }],
      recreated: Array.from({ length: recreated }, (_, i) => ({ table: 'task', rowId: `r-${String(i)}`, label: `R${String(i)}`, by: OTHER, deletedAt: null, deletedBy: null })),
      parentReplaced: Array.from({ length: parent }, (_, i) => ({ table: 'task', rowId: `p-${String(i)}`, column: 'project_id', parentId: 'P', space: 'pro', label: `P${String(i)}`, hlc: 'h' as never, kind: 'reattached' as const, cause: 'parent-replaced' as const })),
      overflow,
      overflowBy: { restored: 0, recreated: overflow, parentReplaced: 0 },
    },
    true,
  );
  return id;
}

/** Compte rendu non acquitté avec bandeau (ou sans), semé directement dans la base. */
async function seed(epoch: string, createdAt: string, labels: readonly string[], banner = true): Promise<number> {
  const reports = await db.data.repos.carryReports();
  const id = await reports.create(head(epoch, createdAt));
  await reports.save(id, body(labels), banner);
  return id;
}

async function start(warnings: readonly string[] = ['carry-report']): Promise<void> {
  sync.setStatus({ warnings: warnings as never });
  integration = startSyncIntegration(container, NO_TIMERS);
  await integration.refreshed();
  render(
    <AppContainerProvider container={container}>
      <AppStatusBanner />
      <SyncDetailsScreen slots={SLOTS} />
    </AppContainerProvider>,
  );
}

const bannerText = (count: number): RegExp => new RegExp(`Changement d.époque : éléments rétablis : ${String(count)}\\. Voir le compte rendu`);

describe('bandeau durable (critère 16)', () => {
  it('levé pour un compte rendu non acquitté, avec le nombre d’éléments ; « Voir » mène aux Détails de la synchro', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A', 'B', 'C']);
    await start();
    expect(await screen.findByText(bannerText(3))).toBeTruthy();
    expect(useAppStatusStore.getState().sources.syncTrouble?.detail).toBe('carry-report');
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'sync' });
  });

  it('plusieurs comptes rendus non acquittés : le nombre est la somme', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A', 'B']);
    await seed('3-a', '2026-10-18T07:30:00.000Z', ['C']);
    await start();
    expect(await screen.findByText(bannerText(3))).toBeTruthy();
  });

  it('aucune ligne rétablie mais d’autres nommées : « aucun élément supprimé rétabli, autres éléments nommés : n » (recréées, rattachées, débordement compris)', async () => {
    await seedOthers('2-a', '2026-10-18T07:00:00.000Z', 2, 1, 3);
    await start();
    expect(await screen.findByText('Changement d’époque : aucun élément supprimé rétabli, autres éléments nommés : 6. Voir le compte rendu')).toBeTruthy();
    expect(screen.queryByText(/éléments rétablis : /)).toBeNull();
  });

  it('un compte rendu avec rétablis et un autre sans : le nombre est celui des seules lignes rétablies', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A']);
    await seedOthers('3-a', '2026-10-18T07:30:00.000Z', 4, 0);
    await start();
    expect(await screen.findByText(bannerText(1))).toBeTruthy();
  });

  it('le moteur ne lève rien : aucun bandeau', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A']);
    await start([]);
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('rien ne lève le bandeau pour un compte rendu sans bandeau (fusion, rien à nommer) ou déjà acquitté ; la marque d’échec le lève', async () => {
    const repos = db.data.repos;
    await seed('2-a', '2026-10-18T07:00:00.000Z', [], false);
    expect(await carryReportRaised(repos)).toBe(false);
    const acked = await seed('3-a', '2026-10-18T07:30:00.000Z', ['A']);
    expect(await carryReportRaised(repos)).toBe(true);
    await (await repos.carryReports()).acknowledge(acked, NOW);
    expect(await carryReportRaised(repos)).toBe(false);
    await repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, JSON.stringify({ epoch: '4-a', at: NOW, code: 'X' }));
    expect(await carryReportRaised(repos)).toBe(true);
  });
});

describe('« J’ai vu » (critère 18)', () => {
  it('acquitte ce seul compte rendu : le bandeau garde l’autre, puis disparaît ; les deux restent dans l’historique', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A', 'B']);
    await seed('3-a', '2026-10-18T07:30:00.000Z', ['C']);
    await start();
    expect(await screen.findByText(bannerText(3))).toBeTruthy();
    const entries = await screen.findAllByRole('button', { name: /^Époque du / });
    expect(entries).toHaveLength(2);
    // Le plus récent en tête : on ouvre le second (le plus ancien, deux éléments) et on le marque vu.
    fireEvent.click(entries[1] as HTMLElement);
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'J’ai vu' }));
    expect(await within(dialog).findByText(/^Vu le /)).toBeTruthy();
    expect(await screen.findByText(bannerText(1))).toBeTruthy();
    const reports = await (await db.data.repos.carryReports()).list(20);
    expect(reports.map((r) => r.acknowledgedAt !== null)).toEqual([false, true]);
    // Le second : « J'ai vu » le retire, l'historique garde les deux.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    fireEvent.click((await screen.findAllByRole('button', { name: /^Époque du / }))[0] as HTMLElement);
    dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'J’ai vu' }));
    expect(await within(dialog).findByText(/^Vu le /)).toBeTruthy();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    expect(screen.queryByText(/Changement d.époque : éléments rétablis/)).toBeNull();
    expect(screen.getAllByText(/^Vu le /).length).toBeGreaterThanOrEqual(2);
  });

  // Revue S1 : le bandeau, acquitté, ne doit pas masquer un compte rendu arrivé au cycle suivant alors que l'avertissement est resté levé.
  it('après le dernier « J’ai vu », un nouveau compte rendu arrivé au cycle suivant lève de nouveau le bandeau', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', ['A']);
    await start();
    expect(await screen.findByText(bannerText(1))).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /^Époque du / }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'J’ai vu' }));
    expect(await within(dialog).findByText(/^Vu le /)).toBeTruthy();
    expect(screen.queryByText(/Changement d.époque : éléments rétablis/)).toBeNull();
    await seed('3-a', '2026-10-18T07:30:00.000Z', ['B', 'C']);
    // Cycle suivant : le moteur lève toujours `carry-report` (nouveau compte rendu non acquitté).
    await act(async () => {
      sync.setStatus({ lastSyncAt: '2026-10-18T08:05:00.000Z' as IsoDateTime, warnings: ['carry-report'] as never });
      await integration?.refreshed();
    });
    expect(await screen.findByText(bannerText(2))).toBeTruthy();
  });

  it('compte rendu sans élément rétabli : lisible dans l’historique, aucun bandeau (critère 19)', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', [], false);
    await start([]);
    fireEvent.click(await screen.findByRole('button', { name: /^Époque du / }));
    expect(within(screen.getByRole('dialog')).getByText('Aucun élément supprimé n’a été rétabli')).toBeTruthy();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('historique : les 20 derniers acquittés seulement, du plus récent au plus ancien', async () => {
    const reports = await db.data.repos.carryReports();
    for (let i = 0; i < 22; i += 1) await reports.acknowledge(await seed(`${String(i)}-a`, new Date(2026, 9, 1 + (i % 28), 10, i).toISOString(), ['A'], false), NOW);
    await start([]);
    expect(await screen.findAllByRole('button', { name: /^Époque du / })).toHaveLength(20);
    expect(screen.getByRole('list', { name: 'Compte rendu du changement d’époque : 20' })).toBeTruthy();
  });

  // Revue I2 : un compte rendu non acquitté n'est jamais élagué ; il doit rester accessible, sinon le bandeau ne peut plus disparaître.
  it('21 comptes rendus non acquittés : les 21 sont dans l’historique (le plus ancien aussi), du plus récent au plus ancien, sans doublon', async () => {
    const reports = await db.data.repos.carryReports();
    const ids: number[] = [];
    for (let i = 0; i < 21; i += 1) ids.push(await seed(`${String(i)}-a`, new Date(2026, 9, 1 + i, 10, 0).toISOString(), ['A']));
    // Deux comptes rendus acquittés plus récents : `list(20)` seul les verrait en tête et pousserait les plus anciens non acquittés dehors.
    for (let i = 21; i < 23; i += 1) await reports.acknowledge(await seed(`${String(i)}-a`, new Date(2026, 9, 1 + i, 10, 0).toISOString(), ['A'], false), NOW);
    await start([]);
    const entries = await screen.findAllByRole('button', { name: /^Époque du / });
    expect(entries).toHaveLength(23);
    expect(screen.getByRole('list', { name: 'Compte rendu du changement d’époque : 23' })).toBeTruthy();
    // Le premier non acquitté (id 1, le plus ancien) est ouvrable et « J'ai vu » l'acquitte.
    fireEvent.click(entries[entries.length - 1] as HTMLElement);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'J’ai vu' }));
    // Une fois acquitté, le plus ancien sort de l'historique (hors des 20 derniers) : la feuille se ferme, les 22 autres restent.
    await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
    expect(screen.getAllByRole('button', { name: /^Époque du / })).toHaveLength(22);
    expect((await reports.get(ids[0] as number))?.acknowledgedAt).not.toBeNull();
  });

  it('sans compte rendu ni échec, la ligne est absente', async () => {
    await start([]);
    expect(screen.queryByText('Compte rendu du changement d’époque')).toBeNull();
  });
});

describe('échec d’enregistrement du compte rendu (critère 14)', () => {
  // Revue S3 : la cause est lisible par famille, le code entre parenthèses.
  it.each([
    ['SQLITE_FULL', 'stockage plein ou illisible (SQLITE_FULL)'],
    ['SQLITE_READONLY', 'écriture refusée par la base de données (SQLITE_READONLY)'],
    ['DbError', 'écriture refusée par la base de données (DbError)'],
    ['unreadable', 'cause inattendue (unreadable)'],
  ])('la cause « %s » est dite par famille : %s', async (code, cause) => {
    await db.data.repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, JSON.stringify({ epoch: '2-a', at: NOW, code }));
    await start();
    const text = `Le compte rendu du changement d’époque n’a pas pu être enregistré : ${cause}`;
    await screen.findByTestId('carry-report-failed');
    expect(screen.getAllByText(text)).toHaveLength(2);
  });

  it('bandeau et Détails disent la cause ; « J’ai vu » efface la marque et le bandeau', async () => {
    await db.data.repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, JSON.stringify({ epoch: '2-a', at: NOW, code: 'ReportRefused' }));
    await start();
    const text = 'Le compte rendu du changement d’époque n’a pas pu être enregistré : cause inattendue (ReportRefused)';
    const row = await screen.findByTestId('carry-report-failed');
    await screen.findByRole('button', { name: 'Voir le problème de synchronisation' });
    expect(screen.getAllByText(text)).toHaveLength(2);
    fireEvent.click(within(row).getByRole('button', { name: 'J’ai vu' }));
    await waitForElementToBeRemoved(() => screen.queryByTestId('carry-report-failed'));
    expect(await db.data.repos.sync.getMeta(EPOCH_CARRY_REPORT_FAILED_META)).toBeNull();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });
});
