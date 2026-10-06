// Y-06 (QA) critères 8, 16 et 22 : fenêtre `pairing` complète (PairingWindow) sur la plateforme mémoire, deux appareils.
// - exposition de la clé : ni le texte du QR, ni la clé maîtresse, ni la clé de secours, ni la saisie dans le DOM hors de l'affichage
//   voulu, le stockage, l'URL, l'historique, le titre, les cookies, la console, ni envoyés par le réseau ou un message ;
// - fermeture par chaque chemin (Annuler, Échap, échéance, démontage, bouton « Fermer » d'une fenêtre en échec) : état vidé, une seule
//   demande de destruction ;
// - exigence d'Ali : une destruction refusée par Rust n'est jamais silencieuse.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import qrcode from 'qrcode-generator';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PAIRING_VALIDITY_MS } from '../../../domain/sync/limits';
import { epochId, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../../domain/sync/format';
import type { DeviceId, Hlc } from '../../../domain/types';
import { syncPairingWindowFr } from '../../../i18n/fr.syncPairing';
import { MemorySyncFolder, SyncPlatformError, createMemorySyncPlatform, type MemorySyncPlatform } from '../../../platform/sync';
import { reducePairingPlatform, type PairingPlatform } from './pairingPlatform';
import { PairingView, PairingWindow, createSecretSlot } from './PairingView';
import { RecoveryKeyEntry } from './RecoveryKeyEntry';

const A = '3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' as DeviceId;
const B = '7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e' as DeviceId;
const E1 = epochId(1, A);
const T = syncPairingWindowFr;
const hlc = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;

let nowMs = 1_800_000_000_000;
const now = (): number => nowMs;

const stateOf = (dev: DeviceId, epoch: EpochId): PublishedDeviceState => ({
  deviceId: dev,
  platform: 'windows',
  appVersion: '0.1.1',
  sm: 1,
  sv: 14,
  epoch,
  stateSeq: 1,
  head: { epoch, segment: 1, record: 1, hlc: hlc(10, dev), stateSeq: 1 },
  acks: new Map<DeviceId, DeviceAck>(),
  snapshot: null,
  purgeHorizon: null,
  lastSyncHlc: hlc(1_000, dev),
  forgotten: [],
  reset: null,
});

async function pc(folder = new MemorySyncFolder()): Promise<MemorySyncPlatform> {
  const p = createMemorySyncPlatform({ folder, nowMs: now });
  await p.folder.choose();
  await p.bindDevice(A);
  await p.key.create();
  await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"k":"ops","n":1}'] });
  await p.writeState({ sv: 14, state: stateOf(A, E1) });
  return p;
}

/** Clé maîtresse `K` (base64url) lue dans le texte du QR. */
const masterKeyOf = (qrText: string): string => (JSON.parse(atob(qrText.slice('CTPAIR1.'.length).replace(/-/g, '+').replace(/_/g, '/'))) as { k: string }).k;

const loadQr = () => Promise.resolve(qrcode);

const tick = async (ms: number): Promise<void> => {
  nowMs += ms;
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

let consoleLines: string[] = [];
let network: Mock<(...args: unknown[]) => unknown>;
let posted: Mock<(...args: unknown[]) => unknown>;

beforeEach(() => {
  nowMs = 1_800_000_000_000;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.clear();
  sessionStorage.clear();
  consoleLines = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(' ')));
  network = vi.fn((..._args: unknown[]) => Promise.reject(new Error('réseau interdit')));
  vi.stubGlobal('fetch', network);
  vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(((...args: unknown[]) => void network(...args)) as never);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: network });
  posted = vi.fn((..._args: unknown[]) => undefined);
  vi.spyOn(window, 'postMessage').mockImplementation(posted as never);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Rien de sensible hors du DOM d'affichage : stockage, URL, historique, titre, cookies, console, réseau, messages. */
function expectNothingOutsideTheScreen(needles: readonly string[], url: string): void {
  const places = [
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
    window.location.href,
    String(window.history.state ?? ''),
    window.name,
    document.title,
    document.cookie,
    consoleLines.join('\n'),
    JSON.stringify(network.mock.calls),
    JSON.stringify(posted.mock.calls),
  ];
  for (const needle of needles) {
    expect(needle.length).toBeGreaterThan(8);
    for (const place of places) expect(place).not.toContain(needle);
  }
  expect(window.location.href).toBe(url);
  expect(network).not.toHaveBeenCalled();
  expect(posted).not.toHaveBeenCalled();
}

describe('exposition de la clé : appairage complet par la fenêtre (critère 16, QA)', () => {
  it('affichage, nouveau code, fermeture, puis import raté et réussi sur le second appareil : aucune trace hors de l’écran voulu', async () => {
    const url = window.location.href;
    const folder = new MemorySyncFolder();
    const a = await pc(folder);
    await a.key.openPairing('show');
    const showSlot = createSecretSlot();
    const shown = reducePairingPlatform(a.key);
    vi.spyOn(shown, 'closePairing');
    const show = render(<PairingView platform={shown} now={now} slot={showSlot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const first = showSlot.peek();
    if (!first) throw new Error('charge utile absente');
    // À l'écran : la clé de secours (voulu) ; jamais le texte du QR ni K en clair, ni dans le nom accessible du QR.
    expect(screen.getByTestId('pairing-recovery-key').textContent).toBe(first.recoveryKey);
    expect(document.body.innerHTML).not.toContain(first.qrText);
    expect(document.body.innerHTML).not.toContain(masterKeyOf(first.qrText));
    expect(screen.getByRole('img', { name: T.window.qrLabel }).getAttribute('aria-label')).not.toMatch(/CT1|CTPAIR/);
    // « Nouveau code ».
    nowMs += 1_000;
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    await waitFor(() => expect(showSlot.peek()?.qrText).not.toBe(first.qrText));
    const second = showSlot.peek();
    if (!second) throw new Error('second code absent');
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    expect(showSlot.peek()).toBeNull();
    expect(shown.closePairing).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(first.recoveryKey);
    expect(document.body.innerHTML).not.toContain(second.recoveryKey);
    show.unmount();

    // Second appareil : saisie erronée (rien d'enregistré), puis la bonne (minuscules, espaces).
    const b = createMemorySyncPlatform({ folder, nowMs: now });
    await b.folder.choose();
    await b.bindDevice(B);
    await b.key.openPairing('import');
    const entry = reducePairingPlatform(b.key);
    render(<RecoveryKeyEntry platform={entry} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
    const field = screen.getByLabelText<HTMLInputElement>(T.import.field);
    const wrong = 'CT1-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
    fireEvent.change(field, { target: { value: wrong } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    await screen.findByTestId('pairing-import-message');
    expect(field.value).toBe('');
    expect(field.getAttribute('value')).toBeNull();
    expect(document.body.innerHTML).not.toContain(wrong);
    const typed = second.recoveryKey.toLowerCase().replace(/-/g, ' ');
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    await screen.findByText(T.import.done);
    expect(field.value).toBe('');
    expect(document.body.innerHTML).not.toContain(typed);
    expect(document.body.innerHTML).not.toContain(second.recoveryKey);
    expect((await b.key.status()).present).toBe(true);

    expectNothingOutsideTheScreen([first.qrText, second.qrText, first.recoveryKey, second.recoveryKey, masterKeyOf(first.qrText), masterKeyOf(second.qrText), wrong, typed], url);
  });

  it('import par QR n’a pas de champ : la fenêtre de saisie ne reçoit jamais le texte du QR', async () => {
    const folder = new MemorySyncFolder();
    const a = await pc(folder);
    await a.key.openPairing('show');
    const payload = await a.key.pairingPayload();
    await a.key.closePairing();
    const b = createMemorySyncPlatform({ folder, nowMs: now });
    await b.folder.choose();
    await b.bindDevice(B);
    await b.key.openPairing('import');
    const entry = reducePairingPlatform(b.key);
    // Même si le texte du QR est collé dans le champ (clé de secours attendue), il part tel quel à Rust et n'est ni gardé ni affiché.
    render(<RecoveryKeyEntry platform={entry} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
    const field = screen.getByLabelText<HTMLInputElement>(T.import.field);
    fireEvent.change(field, { target: { value: payload.qrText } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    const message = await screen.findByTestId('pairing-import-message');
    expect(message.textContent).not.toContain('CTPAIR1');
    expect(document.body.innerHTML).not.toContain(payload.qrText);
    expectNothingOutsideTheScreen([payload.qrText, masterKeyOf(payload.qrText)], window.location.href);
  });
});

describe('fermeture par chaque chemin : état vidé, une seule destruction (critère 8, QA)', () => {
  async function show(): Promise<{ platform: PairingPlatform; slot: ReturnType<typeof createSecretSlot>; secrets: () => string[] }> {
    const a = await pc();
    await a.key.openPairing('show');
    const platform = reducePairingPlatform(a.key);
    vi.spyOn(platform, 'closePairing');
    const slot = createSecretSlot();
    return { platform, slot, secrets: () => [slot.peek()?.recoveryKey ?? '', slot.peek()?.qrText ?? ''].filter((s) => s !== '') };
  }

  it('Échap dans l’instance show', async () => {
    const { platform, slot } = await show();
    render(<PairingView platform={platform} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const key = slot.peek()?.recoveryKey ?? '';
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(slot.peek()).toBeNull();
    expect(platform.closePairing).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(key);
  });

  it('échéance puis clic sur « Fermer » : une seule destruction demandée', async () => {
    const { platform, slot } = await show();
    render(<PairingView platform={platform} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    await tick(PAIRING_VALIDITY_MS);
    expect(slot.peek()).toBeNull();
    expect(screen.getByText(T.window.expired)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: T.window.close }));
    expect(platform.closePairing).toHaveBeenCalledTimes(1);
  });

  it('pendant l’impression : la fermeture efface aussi la feuille de la clé', async () => {
    const { platform, slot } = await show();
    const { container } = render(<PairingView platform={platform} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const key = slot.peek()?.recoveryKey ?? '';
    fireEvent.click(screen.getByRole('button', { name: T.window.print }));
    expect(container.querySelector('.ct-pair__sheet')?.textContent).toContain(key);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.innerHTML).not.toContain(key);
    expect(container.querySelector('.ct-pair__sheet')).toBeNull();
  });

  it('démontage sans fermeture (Rust détruit la fenêtre) : plus rien en mémoire', async () => {
    const { platform, slot } = await show();
    const view = render(<PairingView platform={platform} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    view.unmount();
    expect(slot.peek()).toBeNull();
    expect(view.container.innerHTML).toBe('');
  });

  it('instance import : Annuler, Échap et échéance vident le champ et demandent chacun une seule destruction', async () => {
    for (const path of ['cancel', 'escape', 'expiry'] as const) {
      const folder = new MemorySyncFolder();
      await pc(folder);
      const b = createMemorySyncPlatform({ folder, nowMs: now });
      await b.folder.choose();
      await b.bindDevice(B);
      await b.key.openPairing('import');
      const entry = reducePairingPlatform(b.key);
      vi.spyOn(entry, 'closePairing');
      const view = render(<RecoveryKeyEntry platform={entry} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
      const field = screen.getByLabelText<HTMLInputElement>(T.import.field);
      fireEvent.change(field, { target: { value: 'CT1-SAISIE-EN-COURS' } });
      if (path === 'cancel') fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
      else if (path === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      else await tick(PAIRING_VALIDITY_MS);
      expect(field.value, path).toBe('');
      expect(entry.closePairing, path).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });
});

describe('échecs visibles dans la fenêtre (exigence d’Ali, critère 22)', () => {
  it('pairingPayload refusé : message annoncé (role=status) et bouton pour fermer', async () => {
    const a = await pc();
    await a.key.openPairing('show');
    const platform = reducePairingPlatform(a.key);
    vi.spyOn(platform, 'pairingPayload').mockRejectedValue(new SyncPlatformError('io'));
    vi.spyOn(platform, 'closePairing');
    render(<PairingView platform={platform} now={now} loadQr={loadQr} print={() => undefined} />);
    const status = await screen.findByText(T.window.loadFailed);
    expect(status.getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('button', { name: T.window.close }));
    expect(platform.closePairing).toHaveBeenCalledTimes(1);
  });

  it('chargement du dessinateur de QR en échec : message visible, rien d’affiché de la clé', async () => {
    const a = await pc();
    await a.key.openPairing('show');
    const platform = reducePairingPlatform(a.key);
    const slot = createSecretSlot();
    render(<PairingView platform={platform} now={now} slot={slot} loadQr={() => Promise.reject(new Error('bloc absent'))} print={() => undefined} />);
    expect(await screen.findByText(T.window.loadFailed)).toBeTruthy();
    expect(screen.queryByTestId('pairing-recovery-key')).toBeNull();
  });

  it('PairingWindow : un code d’erreur inconnu de l’import a un texte non vide', async () => {
    const folder = new MemorySyncFolder();
    await pc(folder);
    const b = createMemorySyncPlatform({ folder, nowMs: now });
    await b.folder.choose();
    await b.bindDevice(B);
    await b.key.openPairing('import');
    const entry = reducePairingPlatform(b.key);
    vi.spyOn(entry, 'import').mockRejectedValue(new Error('inattendu'));
    render(<PairingWindow platform={entry} now={now} />);
    const field = await screen.findByLabelText<HTMLInputElement>(T.import.field);
    fireEvent.change(field, { target: { value: 'CT1-ABCDE' } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    const message = await screen.findByTestId('pairing-import-message');
    expect((message.textContent ?? '').trim()).not.toBe('');
    expect(message.textContent).not.toContain('inattendu');
  });

  it('QA 1 (corrigé) : une destruction refusée par Rust (closePairing rejeté) est annoncée et « Fermer » la redemande (PairingView)', async () => {
    const a = await pc();
    await a.key.openPairing('show');
    const platform = reducePairingPlatform(a.key);
    vi.spyOn(platform, 'closePairing').mockRejectedValue(new SyncPlatformError('wrong-window'));
    render(<PairingView platform={platform} now={now} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    // L'état est vidé (bien) ; l'utilisateur doit en plus savoir que la fenêtre n'a pas pu se fermer, et pouvoir réessayer.
    const texts = screen.queryAllByRole('status').map((n) => (n.textContent ?? '').trim());
    expect(texts.some((text) => text !== '')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: T.window.close }));
    expect(platform.closePairing).toHaveBeenCalledTimes(2);
  });

  it('QA 2 (corrigé) : même chose dans l’instance import (RecoveryKeyEntry), échec annoncé', async () => {
    const folder = new MemorySyncFolder();
    await pc(folder);
    const b = createMemorySyncPlatform({ folder, nowMs: now });
    await b.folder.choose();
    await b.bindDevice(B);
    await b.key.openPairing('import');
    const entry = reducePairingPlatform(b.key);
    vi.spyOn(entry, 'closePairing').mockRejectedValue(new SyncPlatformError('wrong-window'));
    render(<RecoveryKeyEntry platform={entry} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    const texts = screen.queryAllByRole('status').map((n) => (n.textContent ?? '').trim());
    expect(texts.some((text) => text !== '' && !text.startsWith('Cette fenêtre se fermera'))).toBe(true);
  });
});
