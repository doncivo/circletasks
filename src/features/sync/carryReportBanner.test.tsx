// Y-TECH-05, critères 14, 16, 18 et 19 : bandeau durable du compte rendu du changement d'époque, ligne et historique de Détails,
// « J'ai vu » (ce seul compte rendu), échec d'enregistrement visible. Base réelle (SQLite Wasm), faux service de synchro dont l'état porte
// l'avertissement `carry-report` que le moteur lève (le moteur réel est exercé par `carryReportScenario.test.tsx`).
import { cleanup, fireEvent, render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
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

  it('compte rendu sans élément rétabli : lisible dans l’historique, aucun bandeau (critère 19)', async () => {
    await seed('2-a', '2026-10-18T07:00:00.000Z', [], false);
    await start([]);
    fireEvent.click(await screen.findByRole('button', { name: /^Époque du / }));
    expect(within(screen.getByRole('dialog')).getByText('Aucun élément supprimé n’a été rétabli')).toBeTruthy();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });

  it('historique : les 20 derniers seulement, du plus récent au plus ancien', async () => {
    for (let i = 0; i < 22; i += 1) await seed(`${String(i)}-a`, new Date(2026, 9, 1 + (i % 28), 10, i).toISOString(), ['A'], false);
    await start([]);
    expect(await screen.findAllByRole('button', { name: /^Époque du / })).toHaveLength(20);
    expect(screen.getByRole('list', { name: 'Compte rendu du changement d’époque : 20' })).toBeTruthy();
  });

  it('sans compte rendu ni échec, la ligne est absente', async () => {
    await start([]);
    expect(screen.queryByText('Compte rendu du changement d’époque')).toBeNull();
  });
});

describe('échec d’enregistrement du compte rendu (critère 14)', () => {
  it('bandeau et Détails disent la cause ; « J’ai vu » efface la marque et le bandeau', async () => {
    await db.data.repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, JSON.stringify({ epoch: '2-a', at: NOW, code: 'ReportRefused' }));
    await start();
    const text = 'Le compte rendu du changement d’époque n’a pas pu être enregistré : ReportRefused';
    const row = await screen.findByTestId('carry-report-failed');
    await screen.findByRole('button', { name: 'Voir le problème de synchronisation' });
    expect(screen.getAllByText(text)).toHaveLength(2);
    fireEvent.click(within(row).getByRole('button', { name: 'J’ai vu' }));
    await waitForElementToBeRemoved(() => screen.queryByTestId('carry-report-failed'));
    expect(await db.data.repos.sync.getMeta(EPOCH_CARRY_REPORT_FAILED_META)).toBeNull();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
  });
});
