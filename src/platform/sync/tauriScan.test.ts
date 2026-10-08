// Y-IOS-02 (ADR 0011 §23 point 2, troisième point d'exposition de la section 2.1) : scan du QR par le JS dans `tauriSync.ts`, avec un faux
// du plugin barcode-scanner. Le texte lu est passé aussitôt à `sync_key_import({ qrText })` ; il n'apparaît jamais dans le résultat, les
// journaux, les erreurs ni un store ; masquage de la page pendant le scan → `cancel()` ; caméra refusée, page masquée, erreur du plugin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTauriSync, type SyncInvoker } from './tauriSync';
import { SYNC_COMMAND_WINDOWS_IOS, type SyncCommand } from './types';

const QR = 'CTPAIR1.c2VjcmV0LXF1aS1uZS1kb2l0LWphbWFpcy1zb3J0aXI';

function fakeDocument(state: DocumentVisibilityState = 'visible') {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    hide() {
      this.visibilityState = 'hidden';
      for (const l of listeners) l();
    },
    listeners,
  };
}

function fakeScanner() {
  let release: ((content: string) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const scanner = {
    checkPermissions: vi.fn(async () => 'granted'),
    requestPermissions: vi.fn(async () => 'granted'),
    scan: vi.fn(
      (_o: { readonly windowed: true; readonly formats: readonly string[] }) =>
        new Promise<{ content: string }>((resolve, reject) => {
          release = (content) => resolve({ content });
          fail = reject;
        }),
    ),
    cancel: vi.fn(async () => fail?.(new Error('cancelled'))),
    openAppSettings: vi.fn(async () => undefined),
    qrFormat: 'QR_CODE',

  };
  return { scanner, read: (content: string) => release?.(content), fail: (error: Error) => fail?.(error) };
}

function setup(results: Partial<Record<SyncCommand, unknown>> = {}, doc = fakeDocument()) {
  const calls: { command: SyncCommand; args: unknown }[] = [];
  const invoke = (async (command: SyncCommand, args?: unknown) => {
    calls.push({ command, args });
    const result = results[command];
    if (typeof result === 'object' && result !== null && 'code' in result) throw result;
    return result ?? null;
  }) as unknown as SyncInvoker;
  const fake = fakeScanner();
  const sync = createTauriSync({ available: true, invoke, scanner: async () => fake.scanner, document: doc as unknown as Document });
  return { sync, calls, fake, doc };
}

/** Il faut laisser les promesses internes avancer jusqu'à l'appel de `scan()` (aucun délai : on attend l'appel lui-même). */
async function untilScanning(fake: ReturnType<typeof fakeScanner>): Promise<void> {
  while (fake.scanner.scan.mock.calls.length === 0) await Promise.resolve();
}

afterEach(() => vi.restoreAllMocks());

describe('scan du QR par le JS (ADR 0011 §23 point 2)', () => {
  it('le texte lu va aussitôt à sync_key_import et n’est rendu, journalisé ni recopié nulle part', async () => {
    const logs: unknown[] = [];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args));
    const { sync, calls, fake } = setup({ sync_key_import: { kid: '0123456789abcdef', pairedBy: 'a', epoch: null } });
    const pending = sync.key.scanAndImport?.();
    await untilScanning(fake);
    expect(fake.scanner.scan).toHaveBeenCalledWith({ windowed: true, formats: ['QR_CODE'] });
    fake.read(QR);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'imported', result: { kid: '0123456789abcdef', pairedBy: 'a', epoch: null } });
    expect(calls).toEqual([{ command: 'sync_key_import', args: { qrText: QR } }]);
    expect(JSON.stringify(outcome)).not.toContain('CTPAIR1');
    expect(JSON.stringify(logs)).not.toContain('CTPAIR1');
  });

  it('refus de Rust : code seul, jamais le texte', async () => {
    const { sync, fake } = setup({ sync_key_import: { code: 'key-mismatch', message: `contenu ${QR}` } });
    const pending = sync.key.scanAndImport?.();
    await untilScanning(fake);
    fake.read(QR);
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'failed', code: 'key-mismatch' });
    expect(JSON.stringify(outcome)).not.toContain('CTPAIR1');
  });

  it('« Annuler » et masquage de la page pendant le scan : cancel(), aucun import', async () => {
    const first = setup();
    const pending = first.sync.key.scanAndImport?.();
    await untilScanning(first.fake);
    await first.sync.key.cancelScan?.();
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(first.fake.scanner.cancel).toHaveBeenCalledTimes(1);
    expect(first.calls).toEqual([]);

    const second = setup();
    const hidden = second.sync.key.scanAndImport?.();
    await untilScanning(second.fake);
    second.doc.hide();
    expect(await hidden).toEqual({ kind: 'cancelled' });
    expect(second.fake.scanner.cancel).toHaveBeenCalledTimes(1);
    expect(second.calls).toEqual([]);
    expect(second.doc.listeners.size).toBe(0);
  });

  it('page au premier plan exigée : aucune caméra ouverte', async () => {
    const { sync, fake } = setup({}, fakeDocument('hidden'));
    expect(await sync.key.scanAndImport?.()).toEqual({ kind: 'failed', code: 'not-foreground' });
    expect(fake.scanner.checkPermissions).not.toHaveBeenCalled();
    expect(fake.scanner.scan).not.toHaveBeenCalled();
  });

  it('caméra : refusée → camera-denied ; à demander → demande d’iOS ; réglages ouverts sur demande', async () => {
    const denied = setup();
    denied.fake.scanner.checkPermissions.mockResolvedValue('denied');
    expect(await denied.sync.key.scanAndImport?.()).toEqual({ kind: 'camera-denied' });
    expect(denied.fake.scanner.scan).not.toHaveBeenCalled();
    expect(await denied.sync.key.cameraPermission?.()).toBe('denied');
    await denied.sync.key.openCameraSettings?.();
    expect(denied.fake.scanner.openAppSettings).toHaveBeenCalledTimes(1);

    const asked = setup();
    asked.fake.scanner.checkPermissions.mockResolvedValue('prompt');
    asked.fake.scanner.requestPermissions.mockResolvedValue('denied');
    expect(await asked.sync.key.scanAndImport?.()).toEqual({ kind: 'camera-denied' });
    expect(asked.fake.scanner.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('erreur du plugin : failed io, jamais son texte', async () => {
    const { sync, fake } = setup();
    const pending = sync.key.scanAndImport?.();
    await untilScanning(fake);
    fake.fail(new Error(`panne ${QR}`));
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'failed', code: 'io' });
  });

  it('PC : aucune méthode de scan ; iPhone : sync_key_import depuis main, aucune commande de la fenêtre pairing', () => {
    const pc = createTauriSync({ available: true, invoke: (async () => null) as unknown as SyncInvoker });
    expect(pc.key.scanAndImport).toBeUndefined();
    expect(pc.key.cameraPermission).toBeUndefined();
    expect(SYNC_COMMAND_WINDOWS_IOS.sync_key_import).toBe('main');
    expect(SYNC_COMMAND_WINDOWS_IOS.sync_device_forget).toBe('main');
    expect(SYNC_COMMAND_WINDOWS_IOS.sync_reset_key).toBe('main');
    for (const command of ['sync_pairing_open', 'sync_pairing_payload', 'sync_pairing_close'] as const) expect(SYNC_COMMAND_WINDOWS_IOS[command]).toBeNull();
  });
});
