import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { syncResetEn } from '../../i18n/en.syncReset';
import { syncResetFr } from '../../i18n/fr.syncReset';
import native from '../../i18n/native/fr.json';
import { createMemorySyncPlatform } from '../../platform/sync/memory';
import type { SyncDeviceStatus, SyncResetStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsReset } from './SyncDetailsReset';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/** Y-11 critères 1, 7, 13, 17, 18 et 19 : emplacement `reset` de Réglages › Synchronisation › Détails, boîte de l'app, textes. */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d7');
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PC2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const NOW = '2026-10-06T08:02:00.000Z';

const self: SyncDeviceStatus = { deviceId: SELF, platform: 'windows', self: true, lastReadAt: NOW as IsoDateTime, status: 'active' };
const other = (deviceId: DeviceId, platform: 'ios' | 'windows', lastReadAt: string | null = null): SyncDeviceStatus => ({ deviceId, platform, self: false, lastReadAt: lastReadAt as IsoDateTime | null, status: 'active' });
const state = (patch: Partial<SyncResetStatus>): SyncResetStatus => ({
  role: 'initiator',
  step: 'waiting-devices',
  by: SELF,
  superseded: false,
  waiting: [],
  reminder: false,
  startedAt: NOW as IsoDateTime,
  resumed: false,
  failure: null,
  ...patch,
});

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;
const platform = createMemorySyncPlatform();

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-06T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud', devices: [self, other(IPHONE, 'ios', '2026-10-01T09:30:00.000Z')] });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  await db.close();
});

const renderIn = (node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);
const slot = () => screen.getByTestId('sync-reset');

describe('action et avertissement (critère 1)', () => {
  it('« Réinitialiser la synchronisation » présent ; la boîte explique tout, « Annuler » a le focus, Échap annule sans rien lancer', () => {
    renderIn(<SyncDetailsScreen />);
    const button = screen.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' });
    fireEvent.click(button);
    const dialog = screen.getByRole('alertdialog', { name: 'Réinitialiser la synchronisation ?' });
    const body = dialog.textContent ?? '';
    for (const part of ['nouvelle clé et une nouvelle clé de secours', 'associés de nouveau (QR ou clé de secours) ou oubliés', 'conservées et fusionnées', 'L’ancienne clé de secours ne servira plus', 'ne lira plus rien de ce qui sera écrit après', 'copie gardée par un appareil perdu', '30 jours dans « Supprimés récemment » d’iCloud']) {
      expect(body, part).toContain(part);
    }
    expect(document.activeElement?.textContent).toBe('Annuler');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sync.resets).toBe(0);
  });

  it('« Continuer » lance la réinitialisation ; issues dites (role=status) : annulée, Synchronisez d’abord (appareil nommé, « Synchroniser »), lancée', async () => {
    renderIn(<SyncDetailsReset />);
    const go = async (): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
      });
    };
    sync.resetOutcome = { kind: 'cancelled' };
    await go();
    expect(within(slot()).getByText('Réinitialisation annulée')).toBeTruthy();
    sync.resetOutcome = { kind: 'lagging', device: IPHONE };
    await go();
    expect(within(slot()).getByText('Synchronisez d’abord : iPhone n’a pas encore été lu jusqu’au bout.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Synchroniser maintenant avant de réinitialiser' }));
    });
    expect(sync.calls).toContain('manual');
    sync.resetOutcome = { kind: 'started', switched: true };
    await go();
    expect(within(slot()).getByText('Nouvelle clé créée.')).toBeTruthy();
    expect(sync.resets).toBe(3);
    expect(slot().getAttribute('role')).toBe('status');
  });
});

describe('étapes, échecs persistants, appareils à associer, rappel (critères 7, 13, 17)', () => {
  it('« Réinitialisation : en attente de 2 appareils », liste (nom, dernière synchro, « Oublier cet appareil »), nouvelle clé de secours', () => {
    sync.setStatus({ devices: [self, other(IPHONE, 'ios', '2026-10-01T09:30:00.000Z'), other(PC2, 'windows')], reset: state({ waiting: [IPHONE, PC2] }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Réinitialisation : en attente de 2 appareils')).toBeTruthy();
    const list = screen.getByTestId('sync-reset-waiting');
    const [iphone, pc] = within(list).getAllByRole('listitem');
    expect(within(iphone as HTMLElement).getByText('iPhone')).toBeTruthy();
    expect(within(iphone as HTMLElement).getByText(/^Dernière synchronisation /)).toBeTruthy();
    expect(within(iphone as HTMLElement).getByRole('button', { name: 'Oublier iPhone' })).toBeTruthy();
    expect(within(pc as HTMLElement).getByText('Jamais synchronisé')).toBeTruthy();
    expect(screen.getByText('L’ancienne clé de secours ne sert plus. Affichez la nouvelle, imprimez-la, puis détruisez l’ancienne feuille.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Afficher et imprimer la nouvelle clé de secours' })).toBeTruthy();
    // Pendant la transition, aucun nouveau lancement.
    expect(screen.queryByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeNull();
  });

  it('échec en rouge avec code lisible, heure et « Réessayer » ; lancement en échec : « Réessayer » rouvre la boîte, « Fermer » l’abandonne', async () => {
    sync.setStatus({ reset: state({ step: 'snapshot', failure: { code: 'vault-unavailable', at: '2026-10-06T08:01:00.000Z' as IsoDateTime, step: 'snapshot' } }) });
    renderIn(<SyncDetailsReset />);
    const failed = within(slot()).getByText('La réinitialisation a échoué (ouverture de la nouvelle époque) : coffre du système indisponible');
    expect(failed.getAttribute('data-trouble')).toBe('true');
    expect(within(slot()).getByText(/^Dernier essai : /)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer la réinitialisation' }));
    });
    expect(sync.calls).toContain('manual');
    cleanup();
    sync.setStatus({ reset: state({ step: 'start', failure: { code: 'not-foreground', at: '2026-10-06T08:01:00.000Z' as IsoDateTime, step: 'start' } }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('La réinitialisation n’a pas pu commencer : CircleTasks n’était pas au premier plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer la réinitialisation' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fermer le message de réinitialisation terminée' }));
    });
    expect(sync.dismissals).toBe(1);
  });

  it('reprise après un arrêt dite ; terminée (reprise) puis « Fermer » ; rappel des 30 jours qui nomme les appareils', async () => {
    sync.setStatus({ reset: state({ step: 'switching', resumed: true }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Reprise après un arrêt de l’app')).toBeTruthy();
    cleanup();
    sync.setStatus({ reset: state({ step: 'done', resumed: true }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Réinitialisation terminée après un arrêt (reprise automatiquement) : l’ancienne clé est effacée')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fermer le message de réinitialisation terminée' }));
    });
    expect(sync.dismissals).toBe(1);
    cleanup();
    sync.setStatus({ reset: state({ waiting: [IPHONE], reminder: true }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Réinitialisation commencée il y a plus de 30 jours : iPhone pas encore associé(s)')).toBeTruthy();
  });
});

describe('appareil à associer de nouveau (critères 8 et 18, D2)', () => {
  it('« Cet appareil doit être associé de nouveau » (distinct de « clé différente »), « Associer cet appareil » ; perdant : appareil gagnant nommé', () => {
    sync.setStatus({ phase: 'reset-required', reset: state({ role: 'required', step: 'required', by: IPHONE }) });
    renderIn(<SyncDetailsScreen />);
    expect(within(slot()).getByText('Cet appareil doit être associé de nouveau')).toBeTruthy();
    expect(within(slot()).getByText(/La synchronisation a été réinitialisée avec une nouvelle clé sur iPhone/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Associer cet appareil|Associer/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeNull();
    cleanup();
    sync.setStatus({ phase: 'reset-required', reset: state({ role: 'initiator', step: 'superseded', superseded: true, by: IPHONE }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Une réinitialisation lancée sur iPhone l’emporte : associez cet appareil avec sa nouvelle clé')).toBeTruthy();
  });
});

describe('textes (critère 19)', () => {
  it('sync.reset : mêmes clés en français et en anglais, aucun texte vide ; boîte native « Annuler » par défaut', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      typeof value === 'string' ? [prefix] : Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
    expect(keys(syncResetEn).sort()).toEqual(keys(syncResetFr).sort());
    for (const text of [...Object.values(syncResetFr), ...Object.values(syncResetEn)]) if (typeof text === 'string') expect(text.length).toBeGreaterThan(0);
    expect(native.consent.resetKey.cancel).toBe('Annuler');
    expect(native.consent.resetKey.instruction.endsWith('?')).toBe(true);
    expect(native.consent.resetKey.content).toContain('L\'ancienne clé de secours ne servira plus');
  });
});

describe('ADR 0011 §18 points 14 à 17 (revue et décision de l’architecte)', () => {
  it('perte face à une restauration : « interrompue par une restauration sur … : relancez-la », relance possible, « Fermer »', async () => {
    sync.setStatus({ reset: state({ step: 'superseded', superseded: true, restore: true, by: IPHONE }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Réinitialisation interrompue par une restauration sur iPhone : relancez-la')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fermer le message de réinitialisation terminée' }));
    });
    expect(sync.dismissals).toBe(1);
  });

  it('perte close (gagnant oublié) : « Réinitialisation interrompue : relancez-la », plus à associer, relance possible', () => {
    sync.setStatus({ reset: state({ step: 'superseded', superseded: true, closed: true, by: null }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('Réinitialisation interrompue : relancez-la')).toBeTruthy();
    expect(screen.queryByText('Cet appareil doit être associé de nouveau')).toBeNull();
    expect(screen.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeTruthy();
  });

  it('réassocié sans instantané couvrant : « En attente d’un instantané à jour de l’appareil qui réinitialise » ; import refusé : raison lisible et « Fermer »', async () => {
    sync.setStatus({ reset: state({ role: 'joined', step: 'joined', by: IPHONE, failure: { code: 'state-mismatch', at: '2026-10-06T08:01:00.000Z' as IsoDateTime, step: 'joined' } }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('En attente d’un instantané à jour de l’appareil qui réinitialise')).toBeTruthy();
    cleanup();
    sync.setStatus({ phase: 'reset-required', reset: state({ role: 'required', step: 'required', by: IPHONE, failure: { code: 'key-mismatch', at: '2026-10-06T08:01:00.000Z' as IsoDateTime, step: 'required' } }) });
    renderIn(<SyncDetailsReset />);
    expect(within(slot()).getByText('La réinitialisation a échoué (association) : cette clé ne correspond pas à la nouvelle clé du dossier')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fermer le message de réinitialisation terminée' }));
    });
    expect(sync.dismissals).toBe(1);
  });

  it('appareil attendu absent de la liste : nom neutre, aucune plateforme inventée, pas d’action (revue 13)', () => {
    const ghost = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
    sync.setStatus({ reset: state({ waiting: [ghost] }) });
    renderIn(<SyncDetailsReset />);
    const list = screen.getByTestId('sync-reset-waiting');
    expect(within(list).getByText('Jamais synchronisé')).toBeTruthy();
    expect(within(list).queryByText(/PC|iPhone/)).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
  });
});
