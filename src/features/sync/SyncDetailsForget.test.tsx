import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { syncForgetEn } from '../../i18n/en.syncForget';
import { syncForgetFr } from '../../i18n/fr.syncForget';
import native from '../../i18n/native/fr.json';
import { createMemorySyncPlatform } from '../../platform/sync/memory';
import type { ForgetStep, SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsForget } from './SyncDetailsForget';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/** Y-10 critères 1, 2, 4, 13, 15, 16, 17 et 18 : action de ligne, boîte de l'app, ligne d'un appareil oublié, emplacement `forget`. */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d7');
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PC2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const NOW = '2026-10-06T08:02:00.000Z';

const self: SyncDeviceStatus = { deviceId: SELF, platform: 'windows', self: true, lastReadAt: NOW as IsoDateTime, status: 'active' };
const other = (deviceId: DeviceId, platform: 'ios' | 'windows', status: SyncDeviceStatus['status'] = 'active'): SyncDeviceStatus => ({ deviceId, platform, self: false, lastReadAt: null, status });

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;
const platform = createMemorySyncPlatform();

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-06T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud', devices: [self, other(IPHONE, 'ios')] });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  await db.close();
});

const renderIn = (node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);
const devicesList = () => screen.getAllByRole('listitem');

describe('ligne APPAREILS (critère 1)', () => {
  it('chaque autre appareil porte « Oublier cet appareil » (nom accessible avec le nom de l’appareil) ; la ligne de l’appareil local n’en a pas', () => {
    sync.setStatus({ devices: [self, other(IPHONE, 'ios'), other(PC2, 'windows')] });
    renderIn(<SyncDetailsScreen />);
    const [mine, iphone, pc] = devicesList();
    expect(within(mine as HTMLElement).queryByRole('button', { name: /Oublier/ })).toBeNull();
    expect(within(iphone as HTMLElement).getByRole('button', { name: 'Oublier iPhone' }).textContent).toBe('Oublier cet appareil');
    expect(within(pc as HTMLElement).getByRole('button', { name: /^Oublier PC/ })).toBeTruthy();
  });

  it('oubli annulé (§18 point 12) : « Oubli annulé : l’appareil qui l’avait oublié a lui-même été oublié » et « Oublier cet appareil » ; aucun instantané à jour : ligne dite', () => {
    sync.setStatus({ devices: [self, other(IPHONE, 'ios'), other(PC2, 'windows', 'forgotten')], forget: { failure: null, deletions: [{ deviceId: PC2, state: 'no-snapshot', waitingFor: null }], revived: [IPHONE] } });
    renderIn(<SyncDetailsScreen />);
    const [, iphone, pc] = devicesList();
    expect(within(iphone as HTMLElement).getByText('Oubli annulé : l’appareil qui l’avait oublié a lui-même été oublié')).toBeTruthy();
    expect(within(iphone as HTMLElement).getByRole('button', { name: 'Oublier iPhone' })).toBeTruthy();
    expect(within(pc as HTMLElement).getByRole('status').textContent).toBe('Oublié · aucun instantané à jour : ouvrez un autre appareil associé');
  });

  it('seul appareil (PC seul, vérification manuelle 1) : aucun bouton, aucune ligne « Oublié »', () => {
    sync.setStatus({ devices: [self] });
    renderIn(<SyncDetailsScreen />);
    expect(screen.queryByRole('button', { name: /Oublier/ })).toBeNull();
    expect(screen.queryByText(/Oublié/)).toBeNull();
  });

  it('appareil oublié : libellé « Oublié », sans bouton ; suppression en attente : « Oublié · suppression des fichiers en attente de {appareil} », puis disparue', () => {
    sync.setStatus({
      devices: [self, other(IPHONE, 'ios', 'forgotten'), other(PC2, 'windows')],
      forget: { failure: null, deletions: [{ deviceId: IPHONE, state: 'waiting', waitingFor: PC2 }] },
    });
    renderIn(<SyncDetailsScreen />);
    const iphone = devicesList()[1] as HTMLElement;
    expect(within(iphone).queryByRole('button', { name: /^Oublier / })).toBeNull();
    expect(within(iphone).getByRole('button', { name: 'Renommer iPhone' })).toBeInTheDocument();
    expect(within(iphone).getByText('Oublié')).toBeTruthy();
    expect(within(iphone).getByRole('status').textContent).toBe('Oublié · suppression des fichiers en attente de PC 2');
    act(() => sync.setStatus({ forget: { failure: null, deletions: [{ deviceId: IPHONE, state: 'deleting', waitingFor: null }] } }));
    expect(within(devicesList()[1] as HTMLElement).getByRole('status').textContent).toBe('Oublié · suppression des fichiers en cours');
    act(() => sync.setStatus({ forget: { failure: null, deletions: [{ deviceId: IPHONE, state: 'finalizing', waitingFor: PC2 }] } }));
    expect(within(devicesList()[1] as HTMLElement).getByRole('status').textContent).toBe('Oublié · finalisation en attente de PC 2');
    act(() => sync.setStatus({ forget: null }));
    expect(within(devicesList()[1] as HTMLElement).queryByRole('status')).toBeNull();
  });

  it('cet appareil oublié (phase forgotten) : aucun bouton « Oublier » sur les autres lignes', () => {
    sync.setStatus({ phase: 'forgotten' });
    renderIn(<SyncDetailsScreen />);
    expect(screen.queryByRole('button', { name: /^Oublier/ })).toBeNull();
  });
});

describe('audit Y-10 (ADR 0011 §18 point 8) : identifiant, appareils jamais vus', () => {
  it('chaque autre appareil affiche les 8 premiers caractères de son identifiant (les mêmes que la boîte native)', () => {
    renderIn(<SyncDetailsScreen />);
    expect(within(devicesList()[1] as HTMLElement).getByText(IPHONE.slice(0, 8))).toBeTruthy(); // UI-REFONTE-04 : 8 caractères, jamais l'identifiant complet
  });

  it('appareil jamais vu : nom neutre « Appareil » et 8 caractères, état « Jamais vu », « Oublier » ; jamais « PC » inventé', () => {
    sync.setStatus({ devices: [self, other(IPHONE, 'ios'), { ...other(PC2, 'windows'), seen: false }] });
    renderIn(<SyncDetailsScreen />);
    const ghost = devicesList()[2] as HTMLElement;
    expect(ghost.textContent).toContain('Appareil non identifié');
    expect(ghost.textContent).toContain('Jamais vu');
    expect(ghost.textContent).not.toMatch(/\bPC\b/);
    expect(within(ghost).getByRole('button', { name: 'Oublier Appareil non identifié' })).toBeTruthy();
    // L'iPhone n'est pas renommé « iPhone bbbb » à cause du fantôme.
    expect((devicesList()[1] as HTMLElement).textContent).toMatch(/^iPhone/);
  });

  it('échec rendu par l’oubli : dit aussi sur la ligne (au cas où il n’aurait pas pu être gardé), annoncé', async () => {
    sync.forgetOutcome = { kind: 'failed', code: 'io' };
    renderIn(<SyncDetailsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Oublier iPhone' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    });
    expect(within(devicesList()[1] as HTMLElement).getByRole('status').textContent).toBe('L’oubli de iPhone a échoué : erreur inattendue');
  });

  it('oubli réussi : la parade proposée (réinitialiser la synchronisation)', async () => {
    renderIn(<SyncDetailsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Oublier iPhone' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    });
    expect(within(devicesList()[1] as HTMLElement).getByRole('status').textContent).toContain('réinitialisez la synchronisation');
  });

  it('débordement de la liste maître (§18 point 5) : échec visible, sans appareil nommé', () => {
    sync.setStatus({ forget: { failure: { deviceId: SELF, code: 'too-large', at: NOW as IsoDateTime, step: 'overflow' }, deletions: [] } });
    renderIn(<SyncDetailsForget />);
    expect(screen.getByRole('status').textContent).toContain('Trop d’oublis dans ce dossier');
  });
});

describe('boîte de l’app avant la confirmation native (critères 2, 3 et 4, D1)', () => {
  it('nomme l’appareil, explique avant tout envoi, « Annuler » a le focus, Échap annule sans rien envoyer', () => {
    renderIn(<SyncDetailsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Oublier iPhone' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Oublier iPhone ?' });
    const text = dialog.textContent ?? '';
    expect(text).toContain('ne sera plus lu au-delà d’un point commun à tous vos appareils');
    expect(text).toContain('ses fichiers seront supprimés d’iCloud');
    expect(text).toContain('30 jours dans « Supprimés récemment »');
    expect(text).toContain('L’oubli ne s’annule pas');
    expect(text).toContain('associé de nouveau');
    // Critère 4 : une phrase sur ce que l'oubli ne règle pas.
    expect(text).toContain('iPhone garde sa copie des données et sa clé : seule « Réinitialiser la synchronisation » coupe son accès aux données futures.');
    expect(document.activeElement?.textContent).toBe('Annuler');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sync.forgets).toEqual([]);
  });

  it('« Continuer » : l’oubli est demandé (confirmation native ensuite) ; boîte native refusée : « Oubli annulé » annoncé', async () => {
    sync.forgetOutcome = { kind: 'cancelled' };
    renderIn(<SyncDetailsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Oublier iPhone' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    });
    expect(sync.forgets).toEqual([IPHONE]);
    expect(within(devicesList()[1] as HTMLElement).getByRole('status').textContent).toBe('Oubli annulé');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('le texte de la boîte native est dans src/i18n/native/fr.json, « Annuler » par défaut', () => {
    expect(native.consent.forgetDevice).toEqual({
      title: 'CircleTasks',
      instruction: 'Oublier cet appareil ?',
      content: expect.stringContaining('ne s\'annule pas') as unknown as string,
      confirm: 'Oublier l\'appareil',
      cancel: 'Annuler',
    });
  });
});

describe('emplacement forget : aucun échec silencieux (critère 15)', () => {
  it('échec persistant : rouge, annoncé, heure en 24 h, « Réessayer » relance l’oubli après la boîte de l’app (Y-10-FIX-01 D1) ; sans chemin ni code brut', async () => {
    sync.setStatus({ forget: { failure: { deviceId: IPHONE, code: 'not-foreground', at: '2026-10-06T07:45:00.000Z' as IsoDateTime, step: 'declare' }, deletions: [] } });
    renderIn(<SyncDetailsForget />);
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('L’oubli de iPhone a échoué : CircleTasks n’était pas au premier plan');
    expect(region.textContent).toMatch(/Dernier essai : \d{2}:\d{2}/);
    expect(region.textContent).not.toMatch(/not-foreground|[\\/]/);
    expect(region.querySelector('[data-trouble="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer d’oublier iPhone' }));
    expect(sync.forgets).toEqual([]);
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Oublier iPhone ?' })).getByRole('button', { name: 'Continuer' }));
    });
    expect(sync.forgets).toEqual([IPHONE]);
  });

  it('échec de suppression : « Réessayer » relance un cycle', async () => {
    sync.setStatus({ forget: { failure: { deviceId: IPHONE, code: 'folder-unreachable', at: NOW as IsoDateTime, step: 'delete' }, deletions: [] } });
    renderIn(<SyncDetailsForget />);
    expect(screen.getByRole('status').textContent).toContain('La suppression des fichiers de iPhone a échoué : dossier de synchronisation introuvable');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer maintenant' }));
    });
    expect(sync.calls).toEqual(['manual']);
  });

  it('rien à dire : emplacement vide', () => {
    const { container: root } = renderIn(<SyncDetailsForget />);
    expect(root.innerHTML).toBe('');
  });
});

describe('Y-10-FIX-01 : « Annuler la demande » sur un oubli en échec', () => {
  const STEPS: readonly ForgetStep[] = ['declare', 'delete', 'rejoin', 'overflow', 'revived'];
  const failed = (step: ForgetStep, deviceId: DeviceId = IPHONE, at = '2026-10-06T07:45:00.000Z'): void =>
    sync.setStatus({ forget: { failure: { deviceId, code: 'rate-limited', at: at as IsoDateTime, step }, deletions: [] } });
  const failureRow = (): HTMLElement => document.querySelector('[data-failed="true"]') as HTMLElement;
  const cancelButton = (): HTMLElement => screen.getByRole('button', { name: 'Annuler la demande d’oubli de iPhone' });

  it('critère 1 : à l’étape declare, deux boutons, « Réessayer » puis « Annuler la demande » à sa droite, noms accessibles qui nomment l’appareil', () => {
    failed('declare');
    renderIn(<SyncDetailsForget />);
    const buttons = within(failureRow()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Réessayer', 'Annuler la demande']);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Réessayer d’oublier iPhone', 'Annuler la demande d’oubli de iPhone']);
    expect(failureRow().textContent).toContain('L’oubli de iPhone a échoué : trop de demandes, réessayez dans 10 minutes');
  });

  it.each(STEPS)('critère 2 : étape %s, « Annuler la demande » présent seulement à declare', (step) => {
    failed(step);
    renderIn(<SyncDetailsForget />);
    const cancel = screen.queryByRole('button', { name: /^Annuler la demande/ });
    if (step === 'declare') expect(cancel).not.toBeNull();
    else expect(cancel).toBeNull();
    // « Réessayer » reste proposé à chaque étape (inchangé).
    expect(within(failureRow()).getAllByRole('button')).toHaveLength(step === 'declare' ? 2 : 1);
  });

  it('critères 3 et 5 : « Annuler la demande » : façade appelée pour cet appareil, ligne disparue, « Demande annulée » annoncé, aucun oubli ni cycle', async () => {
    failed('declare');
    renderIn(<SyncDetailsForget />);
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    expect(sync.cancels).toEqual([IPHONE]);
    expect(sync.forgets).toEqual([]);
    expect(sync.calls).toEqual([]);
    expect(document.querySelector('[data-failed="true"]')).toBeNull();
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('Demande annulée');
    expect(region.textContent).not.toContain('a échoué');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Critère 11 : le focus reste dans la zone de statut, jamais perdu sur le corps de la page.
    expect(document.activeElement).toBe(region);
  });

  it('critère 6 : rien à annuler (échec déjà disparu) : même message neutre, sans erreur', async () => {
    failed('declare');
    sync.cancelOutcome = { kind: 'nothing' };
    renderIn(<SyncDetailsForget />);
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    act(() => sync.setStatus({ forget: null }));
    expect(screen.getByRole('status').textContent).toContain('Demande annulée');
    expect(screen.getByRole('status').querySelector('[data-trouble="true"]')).toBeNull();
  });

  it('critère 7 : un nouvel échec (nouvel oubli refusé) fait revenir la ligne avec ses deux boutons ; « Demande annulée » n’est plus dit', async () => {
    failed('declare');
    renderIn(<SyncDetailsForget />);
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    act(() => failed('declare', IPHONE, '2026-10-06T07:50:00.000Z'));
    expect(within(failureRow()).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).not.toContain('Demande annulée');
  });

  it('critère 12 : annulation refusée (écriture locale) : erreur en rouge, la ligne d’origine reste visible avec ses boutons', async () => {
    failed('declare');
    sync.cancelOutcome = { kind: 'failed', code: 'io' };
    renderIn(<SyncDetailsForget />);
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    expect(failureRow().textContent).toContain('L’oubli de iPhone a échoué');
    const error = screen.getByText('La demande n’a pas pu être annulée : erreur inattendue');
    expect(error.getAttribute('data-trouble')).toBe('true');
    expect(error.className).toContain('ct-sync__forgetText');
    expect(within(failureRow()).getAllByRole('button')).toHaveLength(2);
  });

  it('critère 8 : seul un appui sur un bouton agit : clic, appui, Entrée et Espace sur le texte, la ligne, l’heure ou la zone : rien', () => {
    failed('declare');
    renderIn(<SyncDetailsForget />);
    const text = failureRow().querySelector('[data-trouble="true"]') as HTMLElement;
    for (const target of [text, failureRow(), screen.getByRole('status'), screen.getByText(/^Dernier essai/)]) {
      fireEvent.click(target);
      fireEvent.pointerDown(target);
      fireEvent.keyDown(target, { key: 'Enter' });
      fireEvent.keyDown(target, { key: ' ' });
    }
    expect(sync.forgets).toEqual([]);
    expect(sync.cancels).toEqual([]);
    expect(sync.calls).toEqual([]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('critère 10 : « Réessayer » à declare ouvre la boîte de l’app (texte long, « Annuler » par défaut) ; Annuler ou Échap : rien ne part', () => {
    failed('declare');
    renderIn(<SyncDetailsForget />);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer d’oublier iPhone' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Oublier iPhone ?' });
    expect(dialog.textContent).toContain('L’oubli ne s’annule pas');
    expect(document.activeElement?.textContent).toBe('Annuler');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer d’oublier iPhone' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sync.forgets).toEqual([]);
    // La ligne reste, avec ses deux boutons.
    expect(within(failureRow()).getAllByRole('button')).toHaveLength(2);
  });

  it('ligne APPAREILS : l’échec qu’elle répète disparaît avec l’annulation (aucun reste rouge ailleurs dans l’écran)', async () => {
    sync.forgetOutcome = { kind: 'failed', code: 'rate-limited' };
    const forgetDevice = sync.forgetDevice.bind(sync);
    // Comme le service : l'échec est gardé et l'état relu avant le retour.
    sync.forgetDevice = async (deviceId) => {
      failed('declare', deviceId);
      return forgetDevice(deviceId);
    };
    renderIn(<SyncDetailsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Oublier iPhone' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    });
    const iphoneRow = (): HTMLElement => devicesList()[1] as HTMLElement;
    expect(within(iphoneRow()).getByRole('status').textContent).toBe('L’oubli de iPhone a échoué : trop de demandes, réessayez dans 10 minutes');
    await act(async () => {
      fireEvent.click(cancelButton());
    });
    expect(within(iphoneRow()).queryByRole('status')).toBeNull();
    expect(screen.queryByText(/a échoué/)).toBeNull();
    expect(screen.getByText('Demande annulée')).toBeTruthy();
  });

  it('QA 8 : double appui rapide sur « Annuler la demande » : un seul appel ; les deux boutons sont désactivés pendant l’action', async () => {
    failed('declare');
    let finish: () => void = () => undefined;
    const requested: DeviceId[] = [];
    const cancel = sync.cancelForgetRequest.bind(sync);
    // Annulation retenue jusqu'à `finish` (action en cours) ; chaque appel de la façade est compté.
    sync.cancelForgetRequest = (deviceId) => {
      requested.push(deviceId);
      return new Promise((resolve) => {
        finish = () => void cancel(deviceId).then(resolve);
      });
    };
    renderIn(<SyncDetailsForget />);
    const button = cancelButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(cancelButton()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Réessayer d’oublier iPhone' })).toHaveProperty('disabled', true);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(requested).toEqual([IPHONE]);
    expect(sync.cancels).toEqual([IPHONE]);
    expect(screen.getByRole('status').textContent).toContain('Demande annulée');
  });

  it('QA 8 : « Réessayer » puis « Continuer », boîte native refusée : ligne inchangée avec ses deux boutons, aucune alerte, aucun message d’annulation de la demande', async () => {
    failed('declare');
    sync.forgetOutcome = { kind: 'cancelled' };
    renderIn(<SyncDetailsForget />);
    const before = failureRow().textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer d’oublier iPhone' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Oublier iPhone ?' })).getByRole('button', { name: 'Continuer' }));
    });
    expect(sync.forgets).toEqual([IPHONE]);
    expect(failureRow().textContent).toBe(before);
    expect(within(failureRow()).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).not.toContain('Demande annulée');
  });

  it('autres étapes : « Réessayer » inchangé (cycle), sans boîte', async () => {
    failed('delete');
    renderIn(<SyncDetailsForget />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer maintenant' }));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sync.calls).toEqual(['manual']);
  });
});

describe('appareil oublié qui revient (critères 16 et 17, D2)', () => {
  it('« Cet appareil a été oublié : associez-le de nouveau » ; « Associer de nouveau » : confirmation, association, dossier choisi de nouveau, relance', async () => {
    sync.setStatus({ phase: 'forgotten' });
    const choose = vi.spyOn(platform.folder, 'choose');
    const relaunch = vi.fn(async () => undefined);
    renderIn(<SyncDetailsForget relaunch={relaunch} />);
    expect(screen.getByRole('status').textContent).toContain('Cet appareil a été oublié : associez-le de nouveau');
    fireEvent.click(screen.getByRole('button', { name: 'Associer de nouveau cet appareil' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Associer de nouveau cet appareil ?' });
    expect(dialog.textContent).toContain('Rien n’est effacé');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Associer de nouveau' }));
    });
    expect(sync.rejoins).toBe(1);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('échec de l’association : pas de relance ; l’échec gardé est affiché et « Réessayer » relance l’association', async () => {
    sync.setStatus({ phase: 'forgotten' });
    sync.rejoinOutcome = { kind: 'failed', code: 'folder-unreachable' };
    const relaunch = vi.fn(async () => undefined);
    renderIn(<SyncDetailsForget relaunch={relaunch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Associer de nouveau cet appareil' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Associer de nouveau' }));
    });
    expect(relaunch).not.toHaveBeenCalled();
    act(() => sync.setStatus({ forget: { failure: { deviceId: SELF, code: 'folder-unreachable', at: NOW as IsoDateTime, step: 'rejoin' }, deletions: [] } }));
    expect(screen.getByRole('status').textContent).toContain('L’association de cet appareil a échoué : dossier de synchronisation introuvable');
  });
});

describe('textes (critère 18)', () => {
  const leaves = (value: object, prefix = ''): [string, string][] =>
    Object.entries(value).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v as object, `${prefix}${k}.`)));

  it('fr et en : mêmes clés, aucun texte vide, mêmes paramètres', () => {
    const fr = leaves(syncForgetFr);
    const en = leaves(syncForgetEn);
    expect(en.map(([k]) => k)).toEqual(fr.map(([k]) => k));
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
    for (const [key, text] of fr) {
      expect(text.trim(), key).not.toBe('');
      expect(params(en.find(([k]) => k === key)?.[1] ?? ''), key).toEqual(params(text));
    }
  });

  it('aucun texte français en dur dans les composants de Y-10', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['./SyncDetailsForget.tsx', './ForgetDeviceDialog.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const literals = [...source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2] ?? '');
      for (const text of literals) expect(text, `${file} : ${text}`).not.toMatch(/[àâäéèêëîïôöùûüçœ’«»]/i);
    }
  });
});
