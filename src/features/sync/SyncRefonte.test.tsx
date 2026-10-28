import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, SpaceId, TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemorySyncPlatform } from '../../platform/sync/memory';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { UndoToast } from '../app/UndoToast';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * UI-REFONTE-04 — Réglages › Synchronisation (docs/maquettes-refonte/Synchro-v4.html) : retour texte « Réglages », carte d'état en une
 * phrase (verte seulement quand tout est parti), titres en bas de casse, appareils sur un gabarit avec pastille de statut et sans
 * identifiant interne, conflits nommés (« Heure prévue de « Envoyer la facture » », « Appliquée · iPhone, 18:04 », « Rétablir »),
 * « Repartir de zéro » isolé dans un bloc qui annonce son coût. Aucune logique ne change : les textes d'état restent ceux de la ligne.
 */

const SELF = '60000000-0000-4000-8000-0000000000f4' as DeviceId;
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const OLD_PC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const NOW = '2026-10-05T16:00:00.000Z';
const hlcAt = (iso: string, device: string): Hlc => `${String(Date.parse(iso)).padStart(15, '0')}-0000-${device}` as Hlc;

const devices: SyncDeviceStatus[] = [
  { deviceId: SELF, platform: 'windows', self: true, lastReadAt: NOW as IsoDateTime, status: 'active' },
  { deviceId: IPHONE, platform: 'ios', self: false, lastReadAt: '2026-10-05T15:30:00.000Z' as IsoDateTime, status: 'active' },
  { deviceId: OLD_PC, platform: 'windows', self: false, lastReadAt: '2026-09-16T01:27:00.000Z' as IsoDateTime, status: 'forgotten' },
];

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;
const platform = createMemorySyncPlatform();

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  if (!(await platform.key.status()).present) {
    await platform.folder.choose();
    await platform.key.create();
  }
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T15:58:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud', devices, conflictsThisWeek: 0 });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  await db.close();
});

const renderScreen = () =>
  render(
    <AppContainerProvider container={container}>
      <SyncDetailsScreen />
      <UndoToast />
    </AppContainerProvider>,
  );

/** Présence de la clé lue au rendu : une lecture demandée après celle de l'écran se résout après elle (même plateforme mémoire). */
const keyRead = (): Promise<void> =>
  act(async () => {
    await platform.key.status();
  });

const headings = (): string[] => [...document.querySelectorAll('.ct-sync h2')].map((node) => node.textContent?.trim() ?? '');
const UPPER = /^[A-ZÉÈÀÂÊÎÔÛÇ’' ]{4,}$/;

async function task(title: string): Promise<TaskId> {
  const created = await db.data.repos.tasks.create({
    id: '00000001-0000-4000-8000-0000000000f4' as TaskId,
    spaceId: PRO,
    projectId: null,
    title,
    note: '',
    date: '2026-10-05' as LocalDate,
    time: '09:00' as never,
    status: 'todo',
    doneAt: null,
    sortOrder: 1,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local',
    externalId: null,
    appleListId: null,
    appleRecurring: false,
    externalEventId: null,
  });
  return created.id;
}

async function conflict(rowId: string, field: string, kept: unknown, discarded: unknown): Promise<void> {
  const keptHlc = hlcAt(new Date(2026, 8, 22, 18, 4).toISOString(), IPHONE);
  const discardedHlc = hlcAt(new Date(2026, 8, 22, 17, 58).toISOString(), SELF);
  await db.driver.execute(
    `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
     VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rowId, field, JSON.stringify(kept), JSON.stringify(discarded), IPHONE, SELF, keptHlc, discardedHlc, '2026-09-22T10:00:00.000Z'],
  );
}

describe('UI-REFONTE-04 — Synchronisation', () => {
  it('retour texte « Réglages » (libellé « Retour à Réglages »), titre inchangé, plus de titre « ÉTAT » (critères 1 et 2)', async () => {
    renderScreen();
    await keyRead();
    const back = screen.getByRole('button', { name: 'Retour à Réglages' });
    expect(back).toHaveTextContent('Réglages');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Synchronisation');
    expect(headings()).not.toContain('ÉTAT');
  });

  it('carte d’état : verte seulement quand tout est parti ; phrase d’état et dossier inchangés ; « Synchroniser » à droite (critère 2)', async () => {
    renderScreen();
    await keyRead();
    const card = document.querySelector('.ct-sync__stateCard') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute('data-tone', 'success');
    expect(within(card).getByTestId('sync-status-text')).toHaveTextContent('À jour · il y a 2 min');
    expect(within(card).getByText('iCloud Drive / CircleTasks')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Synchroniser' })).toBeInTheDocument();
    // La phrase d'état garde sa classe et ses attributs (aides e2e, bandeau).
    expect(within(card).getByTestId('sync-status-text')).toHaveClass('ct-sync__sub');
  });

  it('carte d’état : grise avec des fichiers en attente, rouge sur une erreur (règle 5)', async () => {
    sync.setStatus({ pendingFiles: ['bbbbbbbb/e0001/j-00000002.ctj'] });
    renderScreen();
    await keyRead();
    expect(document.querySelector('.ct-sync__stateCard')).toHaveAttribute('data-tone', 'neutral');
    cleanup();
    sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable', pendingFiles: [] });
    renderScreen();
    await keyRead();
    const card = document.querySelector('.ct-sync__stateCard') as HTMLElement;
    expect(card).toHaveAttribute('data-tone', 'danger');
    expect(within(card).getByTestId('sync-status-text')).toHaveTextContent('Dossier de synchro introuvable : vos modifications seront envoyées au retour');
  });

  it('titres de section en bas de casse, dans l’ordre : Appareils, Conflits de cette semaine, Repartir de zéro (critère 3)', async () => {
    sync.setStatus({ pendingFiles: ['bbbbbbbb/e0001/j-00000002.ctj'], warnings: ['folder-large'] });
    renderScreen();
    await keyRead();
    const titles = headings();
    for (const title of titles) expect(title, 'titre en capitales').not.toMatch(UPPER);
    expect(titles).toContain('Appareils');
    expect(titles).toContain('Avertissements');
    expect(titles).toContain('En attente d’iCloud');
    expect(titles).toContain('Conflits de cette semaine');
    expect(titles).toContain('Repartir de zéro');
    expect(titles.indexOf('Appareils')).toBeLessThan(titles.indexOf('Avertissements'));
    expect(titles.indexOf('Avertissements')).toBeLessThan(titles.indexOf('En attente d’iCloud'));
    expect(titles.indexOf('En attente d’iCloud')).toBeLessThan(titles.indexOf('Conflits de cette semaine'));
    expect(titles.indexOf('Conflits de cette semaine')).toBeLessThan(titles.indexOf('Repartir de zéro'));
    const reset = [...document.querySelectorAll('.ct-sync h2')].find((node) => node.textContent?.trim() === 'Repartir de zéro');
    expect(reset).toHaveAttribute('data-tone', 'danger');
  });

  it('appareils : un gabarit, pastille de statut par ton, aucun identifiant affiché, aide sous la liste (critère 4)', async () => {
    renderScreen();
    await keyRead();
    const rows = [...document.querySelectorAll<HTMLElement>('.ct-sync__devices > li')];
    expect(rows).toHaveLength(3);
    const self = rows.find((row) => row.dataset['deviceId'] === SELF) as HTMLElement;
    const phone = rows.find((row) => row.dataset['deviceId'] === IPHONE) as HTMLElement;
    const old = rows.find((row) => row.dataset['deviceId'] === OLD_PC) as HTMLElement;
    expect(self && phone && old).toBeTruthy();
    expect(within(self).getByText('Cet appareil')).toBeInTheDocument();
    expect(self.querySelector('.ct-sync__deviceState')).toHaveTextContent('Actif');
    expect(self.querySelector('.ct-sync__deviceState')).toHaveAttribute('data-tone', 'success');
    expect(old.querySelector('.ct-sync__deviceState')).toHaveTextContent('Oublié');
    expect(old.querySelector('.ct-sync__deviceState')).toHaveAttribute('data-tone', 'muted');
    expect(within(phone).getByText(/^Dernière modification lue : /)).toBeInTheDocument();
    // Aucune valeur interne (règle 4) : pas d'identifiant complet dans la liste ; les autres appareils gardent 8 caractères (audit Y-10 :
    // les mêmes que la boîte native « Oublier cet appareil »), cet appareil aucun.
    const list = document.querySelector('.ct-sync__devices') as HTMLElement;
    expect(list.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/);
    expect(self.textContent).not.toContain(SELF.slice(0, 8));
    expect(within(phone).getByText(IPHONE.slice(0, 8))).toBeInTheDocument();
    // L'aide est sous la liste.
    const hint = screen.getByText(/^Touchez un nom pour le modifier/);
    expect(list.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('appareils : horloge en avance en pastille rouge (critère 4)', async () => {
    sync.setStatus({ phase: 'clock-ahead', clockAheadDevice: IPHONE, devices: [devices[0] as SyncDeviceStatus, { ...(devices[1] as SyncDeviceStatus), status: 'clock-ahead' }] });
    renderScreen();
    await keyRead();
    const phone = [...document.querySelectorAll<HTMLElement>('.ct-sync__devices > li')].find((row) => row.dataset['deviceId'] === IPHONE) as HTMLElement;
    expect(phone.querySelector('.ct-sync__deviceState')).toHaveTextContent('Horloge en avance');
    expect(phone.querySelector('.ct-sync__deviceState')).toHaveAttribute('data-tone', 'danger');
  });

  it('conflits : phrase d’aide, compte, conflit nommé « Heure prévue de « Envoyer la facture » », « Appliquée · iPhone · … », « Rétablir » (critère 5)', async () => {
    sync.setStatus({ conflictsThisWeek: 1 });
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    await keyRead();
    const list = await screen.findByRole('list', { name: 'Journal des conflits' });
    expect(screen.getByText('Deux appareils ont modifié la même chose. La version la plus récente est appliquée.')).toBeInTheDocument();
    expect(screen.getByText('1 conflit cette semaine')).toBeInTheDocument();
    const item = within(list).getByRole('listitem');
    expect(item.querySelector('.ct-conflicts__title')).toHaveTextContent('Heure prévue de « Envoyer la facture »');
    expect(item.textContent).not.toContain('gardée');
    expect(item.textContent).not.toContain('écartée');
    // Heures au format existant de la synchro (« le 22 sept. à 18:04 » hors du jour même).
    expect(item.querySelector('.ct-conflicts__value--kept')).toHaveTextContent(/^09:00Appliquée · iPhone · le 22 sept\. à 18:04$/);
    expect(item.querySelector('.ct-conflicts__value--discarded')).toHaveTextContent(/^10:00PC 1 · le 22 sept\. à 17:58Rétablir$/);
    const button = within(item).getByRole('button', { name: 'Rétablir la valeur écartée : Envoyer la facture, heure prévue' });
    expect(button).toHaveTextContent('Rétablir');
    expect(item).toHaveAccessibleName('Conflit : Envoyer la facture, heure prévue');
  });

  it('repartir de zéro : titre rouge, bloc qui annonce le coût, bouton pleine largeur ; plus de ligne « Nouvelle clé et nouvelle clé de secours » (critère 6)', async () => {
    renderScreen();
    await keyRead();
    const card = document.querySelector('.ct-sync__resetCard') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('Une nouvelle clé est créée.');
    expect(card).toHaveTextContent('Vos autres appareils devront être associés de nouveau');
    expect(card).toHaveTextContent('Vos tâches ne sont pas supprimées.');
    const button = within(card).getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' });
    expect(button).toHaveTextContent('Réinitialiser la synchronisation');
    expect(button).toHaveClass('ct-sync__resetButton');
    expect(screen.queryByText(/^Nouvelle clé et nouvelle clé de secours/)).toBeNull();
    expect(screen.queryByText('RÉINITIALISATION')).toBeNull();
  });
});
