import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Faux plugins Tauri : aucun IPC, les appels sont enregistrés. */
const calls: string[] = [];
const invoke = vi.fn(async (command: string, args?: unknown) => {
  calls.push(`invoke:${command}:${JSON.stringify(args)}`);
});
const unlisten = vi.fn();
const listen = vi.fn(async (event: string, _handler: (e: unknown) => void) => {
  calls.push(`listen:${event}`);
  return unlisten;
});
const getVersion = vi.fn(async () => '0.1.0');
const isEnabled = vi.fn(async () => true);
const enable = vi.fn(async () => {
  calls.push('autostart:enable');
});
const disable = vi.fn(async () => {
  calls.push('autostart:disable');
});
const relaunch = vi.fn(async () => {
  calls.push('relaunch');
});
const openUrl = vi.fn(async (url: string) => {
  calls.push(`open:${url}`);
});

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
const update = {
  version: '1.2.0',
  body: ' Notes de test ' as string | undefined,
  close: vi.fn(async () => undefined),
  downloadAndInstall: vi.fn(async (_cb: (e: DownloadEvent) => void): Promise<void> => undefined),
};
const check = vi.fn(async (): Promise<typeof update | null> => update);

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => getVersion() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (e: string, h: (e: unknown) => void) => listen(e, h) }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled: () => isEnabled(), enable: () => enable(), disable: () => disable() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (u: string) => openUrl(u) }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));

const { createTauriDesktop, classifyUpdateError } = await import('./tauriDesktop');
const { UpdateInstallError } = await import('./types');
const { LATEST_RELEASE_URL, QUICK_ADD_EVENT } = await import('./releases');

describe('intégration PC Tauri (plugins simulés)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    update.body = ' Notes de test ';
    check.mockResolvedValue(update);
  });

  it('envoie les textes du menu à la commande Rust', async () => {
    const labels = { open: 'a', quickAdd: 'b', sync: 'c', quit: 'd', syncEnabled: false };
    await createTauriDesktop().setTrayLabels(labels);
    expect(calls).toEqual([`invoke:set_tray_labels:${JSON.stringify({ labels })}`]);
  });

  it('écoute l’événement « ajout rapide » et renvoie le désabonnement', async () => {
    const handler = vi.fn();
    const stop = await createTauriDesktop().onQuickAdd(handler);
    expect(calls).toEqual([`listen:${QUICK_ADD_EVENT}`]);
    const registered = listen.mock.calls[0]?.[1];
    registered?.({});
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it('démarrage avec Windows : lecture de l’état réel, activation, désactivation', async () => {
    const desktop = createTauriDesktop();
    await expect(desktop.getAutostart()).resolves.toBe(true);
    await desktop.setAutostart(true);
    await desktop.setAutostart(false);
    expect(calls).toEqual(['autostart:enable', 'autostart:disable']);
  });

  it('sortie : le gestionnaire s’exécute, puis la sortie est confirmée, même s’il échoue', async () => {
    const order: string[] = [];
    const desktop = createTauriDesktop();
    await desktop.onQuitting(async () => {
      order.push('écritures');
    });
    const fire = listen.mock.calls.at(-1)?.[1];
    fire?.({});
    await vi.waitFor(() => expect(calls).toContain('invoke:confirm_quit:undefined'));
    expect(order).toEqual(['écritures']);

    calls.length = 0;
    await desktop.onQuitting(() => Promise.reject(new Error('base fermée')));
    listen.mock.calls.at(-1)?.[1]?.({});
    await vi.waitFor(() => expect(calls).toContain('invoke:confirm_quit:undefined'));
  });

  it('version et page de la dernière version', async () => {
    const desktop = createTauriDesktop();
    await expect(desktop.getVersion()).resolves.toBe('0.1.0');
    await desktop.openLatestRelease();
    expect(calls).toEqual([`open:${LATEST_RELEASE_URL}`]);
  });

  it('aucune mise à jour : null', async () => {
    check.mockResolvedValue(null);
    await expect(createTauriDesktop().checkForUpdate()).resolves.toBeNull();
  });

  it('mise à jour annoncée : version et notes ; notes vides = null', async () => {
    const pending = await createTauriDesktop().checkForUpdate();
    expect(pending).toMatchObject({ version: '1.2.0', notes: ' Notes de test ' });
    update.body = '   ';
    expect((await createTauriDesktop().checkForUpdate())?.notes).toBeNull();
    update.body = undefined;
    expect((await createTauriDesktop().checkForUpdate())?.notes).toBeNull();
  });

  it('vérification impossible : l’erreur remonte (la feature la journalise)', async () => {
    check.mockRejectedValue(new Error('réseau'));
    await expect(createTauriDesktop().checkForUpdate()).rejects.toThrow('réseau');
  });

  it('installation : progression cumulée puis redémarrage', async () => {
    update.downloadAndInstall.mockImplementation(async (cb) => {
      cb({ event: 'Started', data: { contentLength: 100 } });
      cb({ event: 'Progress', data: { chunkLength: 30 } });
      cb({ event: 'Progress', data: { chunkLength: 70 } });
      cb({ event: 'Finished' });
    });
    const progress: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];
    const pending = await createTauriDesktop().checkForUpdate();
    await pending?.install((p) => progress.push(p));
    expect(progress).toEqual([
      { downloadedBytes: 0, totalBytes: 100 },
      { downloadedBytes: 30, totalBytes: 100 },
      { downloadedBytes: 100, totalBytes: 100 },
      { downloadedBytes: 100, totalBytes: 100 },
    ]);
    expect(calls).toEqual(['relaunch']);
  });

  it('taille inconnue : total null', async () => {
    update.downloadAndInstall.mockImplementation(async (cb) => cb({ event: 'Started', data: {} }));
    const progress: Array<{ totalBytes: number | null }> = [];
    await (await createTauriDesktop().checkForUpdate())?.install((p) => progress.push(p));
    expect(progress[0]?.totalBytes).toBeNull();
  });

  it('signature refusée : UpdateInstallError « signature », pas de redémarrage', async () => {
    update.downloadAndInstall.mockRejectedValue('Signature verification failed');
    const pending = await createTauriDesktop().checkForUpdate();
    const failure = pending?.install(() => undefined);
    await expect(failure).rejects.toBeInstanceOf(UpdateInstallError);
    await expect(failure).rejects.toMatchObject({ kind: 'signature' });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('autre échec : UpdateInstallError « other »', async () => {
    update.downloadAndInstall.mockRejectedValue(new Error('disque plein'));
    const pending = await createTauriDesktop().checkForUpdate();
    await expect(pending?.install(() => undefined)).rejects.toMatchObject({ kind: 'other' });
  });

  it('libère la ressource Rust, même si elle est déjà fermée', async () => {
    const pending = await createTauriDesktop().checkForUpdate();
    await pending?.dispose();
    expect(update.close).toHaveBeenCalled();
    update.close.mockRejectedValueOnce(new Error('déjà fermée'));
    await expect(pending?.dispose()).resolves.toBeUndefined();
  });
});

describe('classifyUpdateError', () => {
  it.each([
    ['Signature verification failed', 'signature'],
    ['Invalid encoding in minisign data', 'signature'],
    ['The signed version 0.5.0 does not match the announced version 9.9.9', 'signature'],
    ['Could not fetch a valid release JSON from the remote', 'other'],
    ['error sending request', 'other'],
  ])('« %s » -> %s', (message, kind) => {
    expect(classifyUpdateError(new Error(message))).toBe(kind);
    expect(classifyUpdateError(message)).toBe(kind);
  });
});
