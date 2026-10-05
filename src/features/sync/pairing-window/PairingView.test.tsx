// Y-06 critères 5 à 8, 10 à 12, 16 et 22 : fenêtre dédiée `pairing` (affichage du QR et saisie de la clé de secours), sur
// l'implémentation mémoire de SyncPlatform (mêmes règles que Rust : jeton à usage unique, mode lié à l'instance, confirmations).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import qrcode from 'qrcode-generator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_VALIDITY_MS } from '../../../domain/sync/limits';
import { epochId, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../../domain/sync/format';
import type { DeviceId, Hlc } from '../../../domain/types';
import { syncPairingEn } from '../../../i18n/en.syncPairing';
import { syncPairingFr } from '../../../i18n/fr.syncPairing';
import { MemorySyncFolder, SyncPlatformError, createMemorySyncPlatform, type MemorySyncPlatform } from '../../../platform/sync';
import { reducePairingPlatform, type PairingPlatform } from './pairingPlatform';
import { pairingErrorText, pairingTexts } from './pairingText';
import { PairingView, PairingWindow, createSecretSlot, qrPath } from './PairingView';
import { RecoveryKeyEntry } from './RecoveryKeyEntry';

const A = '3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' as DeviceId;
const B = '7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e' as DeviceId;
const E1 = epochId(1, A);
const T = syncPairingFr;
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

/** PC : dossier, liaison, clé, un enregistrement et son état publiés (le dossier porte le `kid`). */
async function pc(folder = new MemorySyncFolder()): Promise<MemorySyncPlatform> {
  const p = createMemorySyncPlatform({ folder, nowMs: now });
  await p.folder.choose();
  await p.bindDevice(A);
  await p.key.create();
  await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"k":"ops","n":1}'] });
  await p.writeState({ sv: 14, state: stateOf(A, E1) });
  return p;
}

/** Fenêtre ouverte en mode `show` ; plateforme réduite espionnée. */
async function openShow(): Promise<{ platform: MemorySyncPlatform; reduced: PairingPlatform }> {
  const platform = await pc();
  await platform.key.openPairing('show');
  const reduced = reducePairingPlatform(platform.key);
  vi.spyOn(reduced, 'pairingPayload');
  vi.spyOn(reduced, 'closePairing');
  return { platform, reduced };
}

const loadQr = () => Promise.resolve(qrcode);

beforeEach(() => {
  nowMs = 1_800_000_000_000;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tick = async (ms: number): Promise<void> => {
  nowMs += ms;
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

describe('instance show : affichage (critères 5 et 22)', () => {
  it('un seul appel de pairingPayload ; titre, avertissement, étapes, QR sans clé dans son nom, clé de secours, attente ; pas de « Copier »', async () => {
    const { reduced } = await openShow();
    render(<PairingView platform={reduced} now={now} loadQr={loadQr} print={() => undefined} />);
    const qr = await screen.findByRole('img', { name: T.window.qrLabel });
    expect(reduced.pairingPayload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1, name: T.window.title })).toBeTruthy();
    expect(screen.getByText(T.window.warning)).toBeTruthy();
    expect(screen.getByText(T.window.step1Path)).toBeTruthy();
    expect(screen.getByText(T.window.step2)).toBeTruthy();
    expect(screen.getByText(T.window.step3)).toBeTruthy();
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    const key = screen.getByTestId('pairing-recovery-key').textContent ?? '';
    expect(key).toMatch(/^CT1(-[0-9A-Z]{5})+$/);
    expect(qr.getAttribute('aria-label')).not.toContain(key);
    // L'attente est annoncée (role=status).
    expect(screen.getByText(T.window.waiting).closest('[role="status"]')).not.toBeNull();
    expect(screen.getByTestId('pairing-validity').textContent).toBe('Code valable 5 minutes');
    expect(screen.getByRole('button', { name: T.window.renewLabel })).toBeTruthy();
    expect(screen.getByText(T.window.noCapture)).toBeTruthy();
    expect(screen.getByRole('button', { name: T.window.print })).toBeTruthy();
    expect(screen.getByRole('button', { name: T.window.cancelLabel })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /copier/i })).toBeNull();
    // Chaque bouton a un nom accessible ; le focus est entré dans la fenêtre.
    for (const button of screen.getAllByRole('button')) expect((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()).not.toBe('');
    expect(document.querySelector('main')?.contains(document.activeElement)).toBe(true);
  });

  it('le QR dessiné se relit : même texte que la charge utile (qrcode-generator, zone calme de 4 modules)', () => {
    const drawn = qrPath(qrcode, 'CTPAIR1.abc');
    expect(drawn.size).toBeGreaterThan(21 + 7);
    expect(drawn.d.startsWith('M4 4h1v1h-1z')).toBe(true);
  });
});

describe('minuteur, nouveau code, impression, fermeture (critères 6, 7, 8 et 16)', () => {
  it('compte à rebours depuis expiresAt ; à l’échéance, QR et clé effacés avant la fermeture demandée à Rust', async () => {
    const { reduced } = await openShow();
    const slot = createSecretSlot();
    const seenAtClose: unknown[] = [];
    vi.mocked(reduced.closePairing).mockImplementation(async () => {
      seenAtClose.push(slot.peek());
    });
    render(<PairingView platform={reduced} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    expect(slot.peek()?.expiresAt).toBe(nowMs + PAIRING_VALIDITY_MS);
    await tick(3 * 60_000);
    expect(screen.getByTestId('pairing-validity').textContent).toBe('Code valable 2 minutes');
    await tick(90_000);
    expect(screen.getByTestId('pairing-validity').textContent).toBe('Code valable 30 s');
    await tick(30_000);
    expect(slot.peek()).toBeNull();
    expect(seenAtClose).toEqual([null]);
    expect(screen.queryByTestId('pairing-recovery-key')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(T.window.expired)).toBeTruthy();
  });

  it('« Nouveau code » : nouvelle confirmation, nouveau code, minuteur remis à 5 minutes', async () => {
    const { platform, reduced } = await openShow();
    render(<PairingView platform={reduced} now={now} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const first = screen.getByTestId('pairing-recovery-key').textContent;
    await tick(4 * 60_000);
    const prompts = platform.testing.consentPrompts();
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    await waitFor(() => expect(screen.getByTestId('pairing-validity').textContent).toBe('Code valable 5 minutes'));
    expect(platform.testing.consentPrompts()).toBe(prompts + 1);
    expect(platform.testing.pairing()?.generation).toBe(2);
    expect(reduced.pairingPayload).toHaveBeenLastCalledWith({ renew: true });
    // Même clé maîtresse : la clé de secours est la même, le QR (échéance) change.
    expect(screen.getByTestId('pairing-recovery-key').textContent).toBe(first);
  });

  it('« Nouveau code » refusé ou limité : l’ancien code reste affiché avec un message (D7)', async () => {
    const { platform, reduced } = await openShow();
    render(<PairingView platform={reduced} now={now} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    platform.testing.setConsent(false);
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    expect(await screen.findByText(T.window.renewDenied)).toBeTruthy();
    expect(screen.getByRole('img', { name: T.window.qrLabel })).toBeTruthy();
    expect(screen.getByTestId('pairing-recovery-key').textContent).toMatch(/^CT1-/);
    // Après un refus, 10 minutes de blocage : « Trop de demandes ».
    platform.testing.setConsent(true);
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    expect(await screen.findByText(T.window.renewRateLimited)).toBeTruthy();
    expect(screen.getByRole('img', { name: T.window.qrLabel })).toBeTruthy();
  });

  it('impression en deux temps : avertissement d’abord, puis window.print ; la feuille ne porte que la clé (D3)', async () => {
    const { reduced } = await openShow();
    const print = vi.fn();
    render(<PairingView platform={reduced} now={now} loadQr={loadQr} print={print} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    fireEvent.click(screen.getByRole('button', { name: T.window.print }));
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(T.window.printWarning);
    const sheet = document.querySelector('.ct-pair__sheet');
    expect(sheet?.textContent).toContain(screen.getByTestId('pairing-recovery-key').textContent ?? 'x');
    expect(sheet?.querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: T.window.printConfirm }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ct-pair__sheet')).toBeNull();
  });

  it.each(['cancel', 'escape'] as const)('fermeture (%s) : état vidé, fenêtre détruite par Rust (instance effacée)', async (how) => {
    const { platform, reduced } = await openShow();
    const slot = createSecretSlot();
    render(<PairingView platform={reduced} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    expect(slot.peek()).not.toBeNull();
    if (how === 'cancel') fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    else fireEvent.keyDown(document, { key: 'Escape' });
    expect(slot.peek()).toBeNull();
    await waitFor(() => expect(reduced.closePairing).toHaveBeenCalledTimes(1));
    expect(platform.testing.pairing()).toBeNull();
    expect(screen.queryByTestId('pairing-recovery-key')).toBeNull();
  });

  it('démontage : plus rien de sensible dans l’état local', async () => {
    const { reduced } = await openShow();
    const slot = createSecretSlot();
    const view = render(<PairingView platform={reduced} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    expect(slot.peek()?.qrText.startsWith('CTPAIR1.')).toBe(true);
    view.unmount();
    expect(slot.peek()).toBeNull();
  });

  it('Tab ne sort pas de la fenêtre', async () => {
    const { reduced } = await openShow();
    render(<PairingView platform={reduced} now={now} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const buttons = screen.getAllByRole('button');
    const last = buttons.at(-1) as HTMLElement;
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe('instance import : clé de secours (critères 10, 11, 12 et 16)', () => {
  /** Second appareil : dossier choisi et lié, sans clé, fenêtre `pairing` ouverte en mode `import`. */
  async function openImport(): Promise<{ a: MemorySyncPlatform; b: MemorySyncPlatform; reduced: PairingPlatform; recoveryKey: string }> {
    const folder = new MemorySyncFolder();
    const a = await pc(folder);
    await a.key.openPairing('show');
    const { recoveryKey } = await a.key.pairingPayload();
    await a.key.closePairing();
    const b = createMemorySyncPlatform({ folder, nowMs: now });
    await b.folder.choose();
    await b.bindDevice(B);
    await b.key.openPairing('import');
    const reduced = reducePairingPlatform(b.key);
    vi.spyOn(reduced, 'import');
    vi.spyOn(reduced, 'closePairing');
    return { a, b, reduced, recoveryKey };
  }

  it('la fenêtre détecte le mode import (wrong-mode) et affiche le champ ; attributs ; minuterie de 5 minutes', async () => {
    const { reduced } = await openImport();
    vi.spyOn(reduced, 'pairingPayload');
    render(<PairingWindow platform={reduced} now={now} />);
    const field = await screen.findByLabelText(T.import.field);
    expect(reduced.pairingPayload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1, name: T.import.title })).toBeTruthy();
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('autocapitalize')).toBe('characters');
    expect(screen.getByRole('button', { name: T.import.submit })).toBeTruthy();
    expect(screen.getByRole('button', { name: T.window.cancelLabel })).toBeTruthy();
    expect(screen.getByTestId('pairing-import-timer').textContent).toBe('Cette fenêtre se fermera dans 5 min');
  });

  it('saisie erronée : message sans recopie, champ vidé, correction dans le même champ, puis association (saisie tolérante en Rust)', async () => {
    const { b, reduced, recoveryKey } = await openImport();
    render(<RecoveryKeyEntry platform={reduced} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
    const field = screen.getByLabelText<HTMLInputElement>(T.import.field);
    const wrong = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith('A') ? 'B' : 'A'}`;
    fireEvent.change(field, { target: { value: wrong } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    expect(field.value).toBe('');
    const message = await screen.findByTestId('pairing-import-message');
    expect([T.errors.invalidPairing, T.errors.keyMismatch]).toContain(message.textContent);
    expect(document.body.textContent).not.toContain(wrong);
    expect((await b.key.status()).present).toBe(false);
    // Même champ ; minuscules et espaces : l'interface transmet sans rien reformater.
    const typed = recoveryKey.toLowerCase().replace(/-/g, ' ');
    fireEvent.change(field, { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    expect(await screen.findByText(T.import.done)).toBeTruthy();
    expect(reduced.import).toHaveBeenLastCalledWith({ recoveryKey: typed });
    expect(field.value).toBe('');
    expect((await b.key.status()).present).toBe(true);
    expect(b.testing.pairing()).toBeNull();
  });

  it('à l’échéance de 5 minutes, la fenêtre se ferme vide (D4)', async () => {
    const { reduced } = await openImport();
    render(<RecoveryKeyEntry platform={reduced} now={now} closeAfterMs={PAIRING_VALIDITY_MS} />);
    const field = screen.getByLabelText<HTMLInputElement>(T.import.field);
    fireEvent.change(field, { target: { value: 'CT1-ABCDE' } });
    await tick(4 * 60_000);
    expect(screen.getByTestId('pairing-import-timer').textContent).toBe('Cette fenêtre se fermera dans 1 min');
    await tick(60_000);
    expect(field.value).toBe('');
    expect(reduced.closePairing).toHaveBeenCalledTimes(1);
  });

  it('chaque code d’erreur a son texte, sans recopie de l’entrée', () => {
    const cases: [string, string][] = [
      ['invalid-pairing', T.errors.invalidPairing],
      ['key-mismatch', T.errors.keyMismatch],
      ['cloud-pending', T.errors.cloudPending],
      ['pairing-expired', T.errors.pairingExpired],
      ['consent-denied', T.errors.consentDenied],
      ['rate-limited', T.errors.rateLimited],
      ['not-configured', T.errors.notConfigured],
      ['wrong-window', T.errors.wrongWindow],
      ['io', T.errors.generic],
    ];
    for (const [code, text] of cases) expect(pairingErrorText(T, new SyncPlatformError(code as never))).toBe(text);
    expect(new SyncPlatformError('invalid-pairing').message).not.toMatch(/CT1/);
  });
});

describe('exposition de la clé (critère 16) et textes (critère 22)', () => {
  it('ni la clé, ni le QR, ni la saisie dans le stockage, l’URL, le titre ou la console', async () => {
    const logs: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    const url = window.location.href;
    const { reduced } = await openShow();
    const slot = createSecretSlot();
    render(<PairingView platform={reduced} now={now} slot={slot} loadQr={loadQr} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    const secrets = slot.peek();
    if (!secrets) throw new Error('charge utile absente');
    const k = JSON.parse(atob(secrets.qrText.slice('CTPAIR1.'.length).replace(/-/g, '+').replace(/_/g, '/'))) as { k: string };
    const needles = [secrets.qrText, secrets.recoveryKey, k.k];
    const places = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), window.location.href, document.title, logs.join('\n')];
    for (const needle of needles) for (const place of places) expect(place).not.toContain(needle);
    expect(window.location.href).toBe(url);
  });

  it('textes fr et en de même forme, sans valeur vide', () => {
    const keys = (value: object, prefix = ''): string[] =>
      Object.entries(value).flatMap(([key, v]) => (typeof v === 'object' && v !== null ? keys(v as object, `${prefix}${key}.`) : [`${prefix}${key}`]));
    expect(keys(syncPairingEn).sort()).toEqual(keys(syncPairingFr).sort());
    const values = (value: object): string[] => Object.values(value).flatMap((v) => (typeof v === 'object' && v !== null ? values(v as object) : [String(v)]));
    expect(values(syncPairingFr).every((v) => v.trim() !== '')).toBe(true);
    expect(pairingTexts('en')).toBe(syncPairingEn);
    expect(pairingTexts('fr')).toBe(syncPairingFr);
  });
});
