import { createMemorySyncPlatform, type MemorySyncFolder, type MemorySyncPlatform } from '../../src/platform/sync/memory';
import { SyncPlatformError, type SyncErrorCode } from '../../src/platform/sync/types';
import { json, startSim, type RunningSim, type SimRequest, type SimResponse } from './httpSim';
import { createSimFolder, propagate } from './syncCloudSim';

/**
 * Simulateur de dossier iCloud pour Playwright (Y-04 critère 12 ; ADR 0011 §12, parcours 10) : chaque page du navigateur de dev reçoit
 * une `SyncPlatform` dont les appels arrivent ici (`globalThis.__ctSyncSim`, client installé par `src/platform/sync/index.ts` en
 * développement seulement). Le simulateur tient le rôle de Rust pour chaque appareil : plateforme mémoire, **son propre** dossier
 * `iCloud Drive/CircleTasks`, son coffre. « iCloud » ne recopie les dossiers que sur ordre du test (`/propagate`) : sans recopie, les
 * appareils sont hors ligne l'un pour l'autre.
 *
 * Les appareils vivent dans un **espace** propre au test (`room`) : deux workers ne partagent jamais un état. Le premier appareil d'un
 * espace choisit son dossier et crée la clé ; le suivant reçoit le dossier du premier et importe sa clé de secours (Y-06 n'est pas
 * requis ici). Rôle `bare` (Y-06, parcours 11) : l'appareil reçoit le dossier du premier et le choisit, **sans clé** : l'association
 * se fait ensuite par l'app (« Associer cet appareil », fenêtre `pairing`). Crochets : panne d'ajout au journal (cycle interrompu), comptage des opérations publiées (aucun doublon).
 *
 * Routes (JSON ; `Map` codées comme dans le client) :
 * - `POST /rpc` `{ room, device, role, platform, path, args }` : appel d'une méthode de `SyncPlatform` ;
 * - `POST /propagate` `{ room }` : recopie mutuelle des dossiers de l'espace (Y-10 : suppressions du dossier d'un appareil oublié comprises) ;
 * - `POST /fail` `{ room, device, method, after, code }` : la méthode échoue (code donné, avant toute écriture) après `after` appels réussis ;
 * - `POST /inspect` `{ room, device }` : identifiant lié, nombre d'ajouts, tâches publiées (nombre de fois par identifiant), budgets
 *   d'hydratation reçus par chaque scan (`hydrateBudgetMs`, null sans) ;
 * - `POST /scan` `{ room, device, from }` (Y-IOS-02) : le prochain scan de l'iPhone `device` lit le QR affiché par l'appareil `from` (produit
 *   ici, comme par la fenêtre `pairing` du PC), jamais un texte venu de la page ;
 * - `POST /camera` `{ room, device, state, answer }` (Y-IOS-02) : autorisation de la caméra simulée de l'iPhone ;
 * - `POST /unreachable` `{ room, device, on }` (Y-IOS-01) : dossier injoignable (signet perdu) : toute méthode répond `folder-unreachable`
 *   jusqu'à `on: false` ou un nouveau choix du dossier. `on: false` remet aussi la liaison à neuf si la page s'est rechargée (la base du
 *   navigateur de dev n'est pas persistée : Rust, lui, retrouve l'appareil lié dans `folder.json`).
 */

const MAP_TAG = '__ctMap';
const encode = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? { [MAP_TAG]: [...(v as Map<unknown, unknown>)] } : v));
const decode = (text: string): unknown =>
  JSON.parse(text, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray((v as Record<string, unknown>)[MAP_TAG]) ? new Map((v as Record<string, [unknown, unknown][]>)[MAP_TAG]) : v));

/** `first` : dossier et clé créés ; `join` : associé au premier par sa clé de secours ; `bare` : dossier du premier, sans clé (Y-06). */
type SimRole = 'first' | 'join' | 'bare' | 'nofolder';

interface SimFailure {
  readonly method: string;
  /** Appels réussis restants avant l'échec. */
  remaining: number;
  readonly code: SyncErrorCode;
}

interface SimSyncDevice {
  readonly name: string;
  readonly folder: MemorySyncFolder;
  readonly platform: MemorySyncPlatform;
  deviceId: string | null;
  appends: number;
  failure: SimFailure | null;
  /** Y-IOS-01 : dossier injoignable (signet perdu). */
  unreachable: boolean;
  /** Y-IOS-01 : liaison remise à neuf au prochain `bindDevice` d'un autre identifiant (page rechargée). */
  rebind: boolean;
  /** Y-IOS-01 : `hydrateBudgetMs` de chaque scan (null : absent). */
  scanBudgets: (number | null)[];
}

interface Room {
  readonly devices: Map<string, SimSyncDevice>;
  /** Y-10 : dossiers d'appareils oubliés supprimés par un appareil actif, pas encore propagés (iCloud propage les suppressions). */
  readonly deletedFolders: Set<string>;
  /** Création en cours d'un appareil (deux appels simultanés de la même page). */
  readonly creating: Map<string, Promise<SimSyncDevice>>;
}

export interface SyncFolderSim extends RunningSim {
  /** Espaces en cours (tests). */
  readonly rooms: ReadonlyMap<string, Room>;
}

const METHODS: ReadonlySet<string> = new Set([
  'folder.info',
  'folder.choose',
  'folder.forget',
  'key.status',
  'key.create',
  'key.openPairing',
  'key.pairingPayload',
  'key.closePairing',
  'key.import',
  // Y-IOS-02 : scan du QR de l'iPhone (texte fourni par le simulateur, jamais par la page).
  'key.scanAndImport',
  'key.cancelScan',
  'key.cameraPermission',
  'key.openCameraSettings',
  'bindDevice',
  'scan',
  'readJournal',
  'appendJournal',
  'writeState',
  'writeSnapshot',
  'readSnapshot',
  'deleteOwn',
  'restoreMarker.get',
  'restoreMarker.clear',
  'forget.device',
  'forget.deleteFiles',
  'reset.start',
]);

/** Recopie mutuelle de tous les dossiers d'un espace (iCloud à jour partout). */
function propagateRoom(room: Room): void {
  // Y-10 : une suppression du dossier d'un appareil oublié atteint toutes les copies, la sienne comprise ; ce qu'il recrée ensuite
  // (avant d'apprendre son oubli) repart normalement.
  for (const id of room.deletedFolders) for (const device of room.devices.values()) device.folder.devices.delete(id);
  room.deletedFolders.clear();
  for (const from of room.devices.values()) {
    for (const to of room.devices.values()) {
      if (from === to) continue;
      for (const id of from.folder.devices.keys()) if (id === from.deviceId) propagate(from.folder, to.folder, id);
    }
  }
}

async function createDevice(room: Room, name: string, role: SimRole, devicePlatform: 'windows' | 'ios'): Promise<SimSyncDevice> {
  const folder = createSimFolder();
  // Plateforme publiée par la page (agent du navigateur) : Rust la connaît, la plateforme mémoire la vérifie dans `writeState`.
  const platform = createMemorySyncPlatform({ folder, platform: devicePlatform });
  const device: SimSyncDevice = { name, folder, platform, deviceId: null, appends: 0, failure: null, unreachable: false, rebind: false, scanBudgets: [] };
  if (role === 'first') {
    await platform.folder.choose();
    await platform.key.create();
    return device;
  }
  const owner = [...room.devices.values()].find((d) => d.deviceId !== null);
  if (!owner?.deviceId) throw new Error('aucun appareil lié dans cet espace : ouvrir d’abord le premier appareil et attendre sa synchro');
  propagate(owner.folder, folder, owner.deviceId);
  // `nofolder` : le dossier du premier est celui que rendra le sélecteur, mais il n'est pas encore choisi (l'utilisateur le choisit dans l'app).
  if (role === 'nofolder') return device;
  await platform.folder.choose();
  // Dossier d'abord, clé ensuite : l'appareil `bare` s'associe lui-même par l'app.
  if (role === 'bare') return device;
  await owner.platform.key.openPairing('show');
  const payload = await owner.platform.key.pairingPayload();
  await owner.platform.key.closePairing();
  // PC : fenêtre dédiée `pairing` ; iPhone : saisie depuis la fenêtre principale (ADR 0011 §2.1).
  if (devicePlatform === 'windows') await platform.key.openPairing('import');
  await platform.key.import({ recoveryKey: payload.recoveryKey });
  return device;
}

async function deviceOf(rooms: Map<string, Room>, roomId: string, name: string, role: SimRole, devicePlatform: 'windows' | 'ios'): Promise<SimSyncDevice> {
  let room = rooms.get(roomId);
  if (!room) {
    room = { devices: new Map(), creating: new Map(), deletedFolders: new Set() };
    rooms.set(roomId, room);
  }
  const known = room.devices.get(name);
  if (known) return known;
  let pending = room.creating.get(name);
  if (!pending) {
    const target = room;
    pending = createDevice(target, name, role, devicePlatform).then((device) => {
      target.devices.set(name, device);
      target.creating.delete(name);
      return device;
    });
    room.creating.set(name, pending);
  }
  return pending;
}

/** Tâches publiées par un appareil dans son dossier : nombre de créations complètes par identifiant. */
function publishedTasks(device: SimSyncDevice): Record<string, number> {
  const seen: Record<string, number> = {};
  if (!device.deviceId) return seen;
  for (const epoch of device.folder.devices.get(device.deviceId)?.epochs.values() ?? []) {
    for (const segment of epoch.segments.values()) {
      for (const line of segment.lines) {
        const record = JSON.parse(line.text) as { ops?: { t: string; id: string; f: Record<string, unknown> }[] };
        for (const op of record.ops ?? []) if (op.t === 'task' && 'title' in op.f) seen[op.id] = (seen[op.id] ?? 0) + 1;
      }
    }
  }
  return seen;
}

async function rpc(rooms: Map<string, Room>, request: SimRequest): Promise<SimResponse> {
  const body = decode(request.body) as { room: string; device: string; role: SimRole; platform?: 'windows' | 'ios'; path: string; args: unknown[] };
  if (!METHODS.has(body.path)) return json(400, { error: { message: `méthode inconnue : ${body.path}` } });
  try {
    const device = await deviceOf(rooms, body.room, body.device, body.role, body.platform === 'ios' ? 'ios' : 'windows');
    const [group, name] = body.path.includes('.') ? (body.path.split('.') as [string, string]) : [null, body.path];
    if (device.unreachable) {
      if (body.path !== 'folder.choose') throw new SyncPlatformError('folder-unreachable');
      device.unreachable = false;
    }
    if (body.path === 'bindDevice' && device.rebind && device.deviceId !== null && device.deviceId !== String(body.args[0])) {
      device.rebind = false;
      await device.platform.folder.forget({ eraseKey: false });
      await device.platform.folder.choose();
    }
    if (body.path === 'scan') {
      const budget = (body.args[0] as { hydrateBudgetMs?: unknown } | undefined)?.hydrateBudgetMs;
      device.scanBudgets.push(typeof budget === 'number' ? budget : null);
    }
    const failure = device.failure;
    if (failure && failure.method === body.path) {
      if (failure.remaining === 0) {
        device.failure = null;
        throw new SyncPlatformError(failure.code);
      }
      failure.remaining -= 1;
    }
    const target = (group ? (device.platform as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[group] : device.platform) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const fn = target[name];
    if (typeof fn !== 'function') return json(400, { error: { message: `méthode inconnue : ${body.path}` } });
    const result = await fn.apply(target, body.path === 'writeSnapshot' ? [snapshotRequest(body.args[0])] : body.args);
    if (body.path === 'bindDevice') device.deviceId = String(body.args[0]);
    if (body.path === 'appendJournal') device.appends += 1;
    if (body.path === 'forget.deleteFiles' && (result as { complete?: boolean } | null)?.complete === true && !device.folder.devices.has(String(body.args[0]))) {
      const target = String(body.args[0]);
      const room = rooms.get(body.room);
      room?.deletedFolders.add(target);
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: encode({ ok: result ?? null }) };
  } catch (error) {
    if (error instanceof SyncPlatformError) return { status: 200, headers: { 'content-type': 'application/json' }, body: encode({ error: { code: error.code } }) };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: encode({ error: { message: error instanceof Error ? error.message : String(error) } }) };
  }
}

/** Les pages d'un instantané arrivent en tableau : rendues itérables comme l'attend la plateforme. */
function snapshotRequest(raw: unknown): unknown {
  const r = raw as { records: (readonly string[])[] };
  return {
    ...r,
    records: (async function* pages() {
      for (const page of r.records) yield page;
    })(),
  };
}

export async function startSyncFolderSim(port = 0): Promise<SyncFolderSim> {
  const rooms = new Map<string, Room>();
  const sim = await startSim(async (request) => {
    if (request.method !== 'POST') return json(404, {});
    switch (request.url.pathname) {
      case '/rpc':
        return rpc(rooms, request);
      case '/propagate': {
        const { room } = JSON.parse(request.body) as { room: string };
        const found = rooms.get(room);
        if (found) propagateRoom(found);
        return json(200, { ok: Boolean(found) });
      }
      case '/fail': {
        const { room, device, method, after, code } = JSON.parse(request.body) as { room: string; device: string; method: string; after: number; code: SyncErrorCode };
        const target = rooms.get(room)?.devices.get(device);
        if (!target) return json(404, { ok: false });
        target.failure = { method, remaining: after, code };
        return json(200, { ok: true });
      }
      case '/inspect': {
        const { room, device } = JSON.parse(request.body) as { room: string; device: string };
        const target = rooms.get(room)?.devices.get(device);
        if (!target) return json(404, { ok: false });
        return json(200, { deviceId: target.deviceId, appends: target.appends, tasks: publishedTasks(target), failing: target.failure !== null, scanBudgets: target.scanBudgets });
      }
      case '/scan': {
        const { room, device, from } = JSON.parse(request.body) as { room: string; device: string; from: string };
        const found = rooms.get(room);
        const target = found?.devices.get(device);
        const owner = found?.devices.get(from);
        if (!target || !owner) return json(404, { ok: false });
        await owner.platform.key.openPairing('show');
        const payload = await owner.platform.key.pairingPayload();
        await owner.platform.key.closePairing();
        target.platform.testing.setScanResult(payload.qrText);
        return json(200, { ok: true });
      }
      case '/camera': {
        const { room, device, state, answer } = JSON.parse(request.body) as { room: string; device: string; state: 'granted' | 'denied' | 'prompt'; answer?: 'granted' | 'denied' };
        const target = rooms.get(room)?.devices.get(device);
        if (!target) return json(404, { ok: false });
        target.platform.testing.setCameraPermission(state, answer);
        return json(200, { ok: true, opened: target.platform.testing.cameraSettingsOpened() });
      }
      case '/unreachable': {
        const { room, device, on } = JSON.parse(request.body) as { room: string; device: string; on: boolean };
        const target = rooms.get(room)?.devices.get(device);
        if (!target) return json(404, { ok: false });
        target.unreachable = on;
        if (!on) target.rebind = true;
        return json(200, { ok: true });
      }
      case '/close-room': {
        const { room } = JSON.parse(request.body) as { room: string };
        rooms.delete(room);
        return json(200, { ok: true });
      }
      default:
        return json(404, {});
    }
  }, port);
  return { ...sim, rooms };
}
