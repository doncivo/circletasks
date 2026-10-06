import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../../../src/domain/hlc';
import { PAIRING_VALIDITY_MS } from '../../../../src/domain/sync/format';
import { SYNC_TABLES } from '../../../../src/domain/sync/syncTables';
import type { DeviceId } from '../../../../src/domain/types';
import { createAppContainer } from '../../../../src/features/app/container';
import { useAppStore } from '../../../../src/features/app/appStore';
import { useNavigationStore } from '../../../../src/features/app/navigation';
import { syncStore } from '../../../../src/features/sync/syncStore';
import type { MemorySyncFolder } from '../../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { propagate } from '../../../sim/syncCloudSim';
import { fromBase64Url, headerLine, openRecord, sealRecord, toBase64Url, type RecordPlace } from '../../../sim/syncCodec';
import { createSimDevice, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Parcours 11 en simulation (Y-06 critère 19, ADR 0011 section 12) : « PC » et « second appareil », deux bases, deux coffres, deux
 * dossiers. Le PC choisit le dossier (clé créée), crée « Test synchro » ; les fichiers du dossier, tels que Rust les écrit (chiffrés
 * par le codec de référence, vrai AES-256-GCM avec l'AAD de la section 2), ne contiennent ni le titre ni un nom de table ; le second
 * appareil importe le QR (puis, second cas, la clé de secours), fait son premier cycle et lit la tâche. Cas d'erreur : QR expiré de plus
 * de 2 minutes, clé erronée (rien d'enregistré), dossier encore vide. Le PC voit l'arrivée (`pairedBy` complété par la plateforme).
 *
 * Critère 16 : pendant tout l'appairage, ni la clé, ni le texte du QR, ni la clé de secours, ni la saisie, ni le titre de la tâche
 * n'apparaissent dans les journaux techniques, la console, l'état des stores Zustand ou le stockage. Critère 18 (c) : `key-mismatch`
 * global vu par le moteur.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TITLE = 'Test synchro';

let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function device(id: string, name: string, base?: SimDevice): Promise<SimDevice> {
  const d = await createSimDevice(id, base ? { name, clock: base.clock } : { name });
  devices.push(d);
  return d;
}

/** Clé maîtresse `K` contenue dans le texte du QR (`CTPAIR1.<base64url(JSON)>`). */
function keyOfQr(qrText: string): Uint8Array<ArrayBuffer> {
  const json = JSON.parse(new TextDecoder().decode(fromBase64Url(qrText.slice('CTPAIR1.'.length)) ?? new Uint8Array())) as { k: string };
  const key = fromBase64Url(json.k);
  if (!key) throw new Error('clé absente du QR');
  return key;
}

/** Octets de tous les fichiers du dossier tels que Rust les écrit : en-tête en clair, puis une ligne chiffrée par enregistrement. */
async function folderBytes(folder: MemorySyncFolder, key: Uint8Array<ArrayBuffer>): Promise<{ files: Map<string, string>; plain: string[] }> {
  const files = new Map<string, string>();
  const plain: string[] = [];
  for (const [dev, dir] of folder.devices) {
    const write = async (name: string, file: { header: Parameters<typeof headerLine>[0]; lines: readonly { sm: number; sv: number; text: string }[] }, place: (index: number) => RecordPlace): Promise<void> => {
      const lines = [headerLine(file.header)];
      for (const [index, line] of file.lines.entries()) {
        const sealed = await sealRecord({ key, place: place(index), json: line.text, sm: line.sm, sv: line.sv });
        // Le codec relit ce qu'il a scellé : la ligne chiffrée porte bien l'enregistrement.
        expect((await openRecord(key, place(index), sealed))?.json).toBe(line.text);
        lines.push(sealed);
        plain.push(line.text);
      }
      files.set(`${dev}/${name}`, lines.map((l) => `${l}\n`).join(''));
    };
    if (dir.state) await write('state.ctx', dir.state, () => ({ kind: 'state', dev, epoch: dir.state?.header.e ?? '', stateSeq: dir.state?.header.n ?? 0 }));
    for (const [epoch, epochDir] of dir.epochs) {
      for (const [n, file] of epochDir.segments) await write(`${epoch}/j-${String(n)}`, file, (index) => ({ kind: 'j', dev, epoch, segment: n, index }));
      for (const [n, file] of epochDir.snapshots) await write(`${epoch}/s-${String(n)}`, file, (index) => ({ kind: 's', dev, epoch, seq: n, index }));
    }
  }
  return { files, plain };
}

const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof SyncPlatformError ? error.code : `autre : ${String(error)}`;
  }
};

/** PC configuré qui a publié « Test synchro ». */
async function pcWithTask(): Promise<{ pc: SimDevice; taskId: string }> {
  const pc = await device(PC_ID, 'PC');
  await setupFirst(pc);
  const task = await pc.createTask(TITLE, { note: 'Note du parcours 11' });
  expect((await pc.cycle()).phase).toBe('idle');
  return { pc, taskId: task.id };
}

/** Affichage sur le PC (fenêtre `pairing`, instance `show`) : charge utile, puis fermeture. */
async function showOnPc(pc: SimDevice): Promise<{ qrText: string; recoveryKey: string; expiresAt: number }> {
  await pc.platform.key.openPairing('show');
  const payload = await pc.platform.key.pairingPayload();
  await pc.platform.key.closePairing();
  return payload;
}

/** Second appareil : dossier choisi (dossier d'abord), fenêtre `pairing` en mode `import`. */
async function readyToImport(phone: SimDevice): Promise<void> {
  await phone.platform.folder.choose();
  await phone.platform.key.openPairing('import');
}

describe('parcours 11 en simulation (critère 19)', () => {
  it('QR : fichiers chiffrés sans titre ni nom de table, tâche lisible sur le second appareil, arrivée vue par le PC', async () => {
    const { pc, taskId } = await pcWithTask();
    const payload = await showOnPc(pc);
    const key = keyOfQr(payload.qrText);
    const { files, plain } = await folderBytes(pc.folder, key);
    expect(files.size).toBeGreaterThanOrEqual(2);
    expect([...files.keys()].some((name) => !name.endsWith('state.ctx'))).toBe(true);
    expect(plain.join('\n')).toContain(TITLE);
    for (const text of files.values()) {
      expect(text).not.toContain(TITLE);
      for (const table of SYNC_TABLES) expect(text).not.toContain(`"${table.name}"`);
      expect(text).not.toContain(payload.recoveryKey);
      expect(text).not.toContain(toBase64Url(key));
    }

    const phone = await device(PHONE_ID, 'iPhone', pc);
    propagate(pc.folder, phone.folder, PC_ID);
    await readyToImport(phone);
    const result = await phone.platform.key.import({ qrText: payload.qrText });
    expect(result.pairedBy).toBe(PC_ID);
    expect((await phone.cycle()).phase).toBe('idle');
    const [onPc, onPhone] = await Promise.all([pc.task(taskId as never), phone.task(taskId as never)]);
    expect(onPhone?.title).toBe(TITLE);
    expect(onPhone).toMatchObject({ title: onPc?.title, note: onPc?.note, date: onPc?.date, spaceId: onPc?.spaceId, status: onPc?.status });

    // Le moteur omet pairedBy : la plateforme (Rust, maître) le complète ; l'état est publié et le PC voit l'arrivée.
    expect(phone.logger.entries.some((e) => e.event === 'write-state-failed')).toBe(false);
    syncFolders(devices);
    const scan = await pc.platform.scan({ keep: [] });
    expect(scan.devices.find((d) => d.deviceId === PHONE_ID)?.state?.pairedBy).toBe(PC_ID);
    expect((await pc.cycle()).devices.map((d) => d.deviceId)).toContain(PHONE_ID);
  });

  it('clé de secours : même résultat (saisie tolérante : minuscules et espaces)', async () => {
    const { pc, taskId } = await pcWithTask();
    const payload = await showOnPc(pc);
    const phone = await device(PHONE_ID, 'iPhone', pc);
    propagate(pc.folder, phone.folder, PC_ID);
    await readyToImport(phone);
    const result = await phone.platform.key.import({ recoveryKey: payload.recoveryKey.toLowerCase().replace(/-/g, ' ') });
    expect(result.pairedBy).toBeNull();
    expect((await phone.cycle()).phase).toBe('idle');
    expect((await phone.task(taskId as never))?.title).toBe(TITLE);
  });

  it('erreurs : QR expiré de plus de 2 minutes, clé erronée (rien d’enregistré), dossier encore vide', async () => {
    const { pc } = await pcWithTask();
    const payload = await showOnPc(pc);
    // Dossier encore vide (iCloud n'a rien apporté) : cloud-pending, rien d'enregistré.
    const phone = await device(PHONE_ID, 'iPhone', pc);
    await readyToImport(phone);
    expect(await errorCode(phone.platform.key.import({ qrText: payload.qrText }))).toBe('cloud-pending');
    expect((await phone.platform.key.status()).present).toBe(false);
    propagate(pc.folder, phone.folder, PC_ID);
    // Clé d'un autre dossier : key-mismatch, rien d'enregistré.
    const other = await device(OTHER_ID, 'Autre', pc);
    await setupFirst(other);
    expect((await other.cycle()).phase).toBe('idle');
    const foreign = await showOnPc(other);
    expect(await errorCode(phone.platform.key.import({ recoveryKey: foreign.recoveryKey }))).toBe('key-mismatch');
    expect((await phone.platform.key.status()).present).toBe(false);
    // QR expiré de plus de 2 minutes.
    pc.clock.set(payload.expiresAt + 2 * 60_000 + 1);
    // La fenêtre d'import a été détruite à 5 minutes : nouvelle fenêtre, même QR.
    await phone.platform.key.openPairing('import');
    expect(await errorCode(phone.platform.key.import({ qrText: payload.qrText }))).toBe('pairing-expired');
    expect((await phone.platform.key.status()).present).toBe(false);
    expect(payload.expiresAt - PAIRING_VALIDITY_MS).toBeLessThanOrEqual(pc.clock.nowMs());
  });
});

describe('exposition de la clé pendant un appairage complet (critère 16)', () => {
  it('ni K, ni QR, ni clé de secours, ni saisie, ni titre dans les journaux, la console ou les stores', async () => {
    const consoleLines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleLines.push(args.map(String).join(' ')));
    const { pc } = await pcWithTask();
    // Affichage, puis « Nouveau code ».
    await pc.platform.key.openPairing('show');
    const first = await pc.platform.key.pairingPayload();
    const renewed = await pc.platform.key.pairingPayload({ renew: true });
    await pc.platform.key.closePairing();
    // Import par la clé de secours sur un second appareil, avec une saisie d'abord erronée.
    const phone = await device(PHONE_ID, 'iPhone', pc);
    propagate(pc.folder, phone.folder, PC_ID);
    await readyToImport(phone);
    const typed = `${first.recoveryKey.toLowerCase()} `;
    expect(await errorCode(phone.platform.key.import({ recoveryKey: 'ct1-zzzzz' }))).toBe('invalid-pairing');
    await phone.platform.key.import({ recoveryKey: typed });
    expect((await phone.cycle()).phase).toBe('idle');
    // Import par QR sur un troisième appareil.
    const third = await device(OTHER_ID, 'Second PC', pc);
    syncFolders(devices);
    await readyToImport(third);
    await third.platform.key.import({ qrText: renewed.qrText });
    expect((await third.cycle()).phase).toBe('idle');

    const k = keyOfQr(first.qrText);
    const needles = [first.qrText, renewed.qrText, first.recoveryKey, typed.trim(), toBase64Url(k), btoa(String.fromCharCode(...k)), TITLE];
    const stores: unknown[] = [useAppStore.getState(), useNavigationStore.getState()];
    for (const d of devices) {
      const container = createAppContainer({ clock: d.clock, hlc: createHlcClock({ clock: d.clock, deviceId: d.id as DeviceId }), data: d.data, sync: d.service, syncPlatform: d.platform });
      stores.push(syncStore.get(container).getState());
    }
    const haystacks = [
      ...devices.map((d) => JSON.stringify(d.logger.entries)),
      consoleLines.join('\n'),
      JSON.stringify(stores),
      typeof localStorage === 'undefined' ? '' : JSON.stringify({ ...localStorage }),
      typeof sessionStorage === 'undefined' ? '' : JSON.stringify({ ...sessionStorage }),
    ];
    for (const needle of needles) for (const haystack of haystacks) expect(haystack).not.toContain(needle);
    // SyncPlatformError ne recopie jamais l'entrée.
    try {
      await phone.platform.key.import({ recoveryKey: 'ct1-aaaaa-entree-secrete' });
    } catch (error) {
      expect(String(error)).not.toContain('entree-secrete');
      expect(JSON.stringify(error)).not.toContain('entree-secrete');
    }
  });
});

describe('key-mismatch global vu par le moteur (critère 18 c)', () => {
  it('aucun appareil connu ne partage la clé locale : phase key-mismatch ; dès qu’un appareil la partage, l’autre n’est que foreign', async () => {
    const pc = await device(PC_ID, 'PC');
    await setupFirst(pc);
    expect((await pc.cycle()).phase).toBe('idle');
    const stranger = await device(OTHER_ID, 'Autre', pc);
    await setupFirst(stranger);
    expect((await stranger.cycle()).phase).toBe('idle');
    // Le dossier du PC reçoit les fichiers d'un appareil chiffrés avec une autre clé : seul autre appareil, clé différente.
    propagate(stranger.folder, pc.folder, OTHER_ID);
    expect((await pc.cycle()).phase).toBe('key-mismatch');
    // Un second appareil associé au PC (même clé) arrive : l'inconnu n'est plus que « Clé différente ».
    const phone = await device(PHONE_ID, 'iPhone', pc);
    propagate(pc.folder, phone.folder, PC_ID);
    const payload = await showOnPc(pc);
    await readyToImport(phone);
    await phone.platform.key.import({ recoveryKey: payload.recoveryKey });
    expect((await phone.cycle()).phase).toBe('idle');
    propagate(phone.folder, pc.folder, PHONE_ID);
    const status = await pc.cycle();
    expect(status.phase).not.toBe('key-mismatch');
    expect(await pc.driver.select('SELECT status FROM sync_state WHERE device_id = ?', [OTHER_ID])).toEqual([{ status: 'foreign' }]);
  });
});
