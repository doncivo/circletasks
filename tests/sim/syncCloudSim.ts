import { MemorySyncFolder } from '../../src/platform/sync/memory';
import { STATE_FILE, parseSyncFileName, segmentFileName } from '../../src/domain/sync/format';

/**
 * « iCloud » simulé à deux dossiers (ADR 0011, section 12 ; Y-02, Y-05, Y-09) : chaque appareil a **son propre** dossier
 * `iCloud Drive/CircleTasks` (un `MemorySyncFolder`) ; le test ordonne la recopie du dossier d'un appareil vers le dossier d'un autre, avec
 * les défauts réels d'iCloud : dernière ligne incomplète, fichier resté dans le nuage, fichier pas encore arrivé, copie de conflit,
 * ancien `state.ctx` relivré.
 *
 * Les enregistrements sont gardés en texte clair par `memory.ts` (le chiffrement réel est vérifié par le codec de référence et les vecteurs
 * croisés du lot Y1) ; la taille sur disque est celle des lignes chiffrées.
 */

/** Même identifiant de dossier sur tous les appareils : c'est « le » dossier CircleTasks, vu de chaque appareil. */
export const SIM_FOLDER_ID = 'icloud-circletasks';

type DeviceDir = MemorySyncFolder['devices'] extends Map<string, infer D> ? D : never;

export interface PropagateOptions {
  /** La dernière ligne du dernier segment arrive incomplète (transfert en cours). */
  readonly partialLastLine?: boolean;
  /** Les fichiers recopiés restent « dans le nuage » (placeholders) chez le destinataire. */
  readonly placeholder?: boolean;
  /** Fichiers non recopiés (pas encore arrivés) : noms `state.ctx` ou `<époque>/<nom>`. */
  readonly drop?: readonly string[];
  /** Une copie de conflit iCloud (« state 2.ctx ») apparaît à côté. */
  readonly conflictCopy?: boolean;
  /** `state.ctx` du destinataire laissé dans sa version précédente (iCloud relivre un ancien état). */
  readonly staleState?: boolean;
  /**
   * Y-TECH-03 : suppressions de l'émetteur pas encore transmises (différées) : fichiers absents chez `from` mais gardés chez `to` dans leur
   * version précédente (noms `state.ctx` ou `<époque>/<nom>`) ; transmises au prochain `propagate` sans cette option.
   */
  readonly deferDeletions?: readonly string[];
}

export function createSimFolder(): MemorySyncFolder {
  return new MemorySyncFolder(SIM_FOLDER_ID);
}

/** Recopie le dossier `devices/<deviceId>/` de `from` vers `to` (remplace la version de `to`). */
export function propagate(from: MemorySyncFolder, to: MemorySyncFolder, deviceId: string, options: PropagateOptions = {}): void {
  const source = from.devices.get(deviceId);
  if (!source) return;
  const previousState = to.devices.get(deviceId)?.state ?? null;
  const copy = structuredClone(source) as DeviceDir;
  for (const name of options.drop ?? []) {
    if (name === STATE_FILE) {
      copy.state = null;
      continue;
    }
    const [epoch, file] = name.split('/');
    const parsed = file ? parseSyncFileName(file) : null;
    const dir = epoch ? copy.epochs.get(epoch as never) : undefined;
    if (!dir || !parsed || parsed.kind === 'state') continue;
    (parsed.kind === 'segment' ? dir.segments : dir.snapshots).delete(parsed.n);
  }
  if (options.staleState) copy.state = previousState ? structuredClone(previousState) : null;
  // Y-TECH-03 (plan de pannes) : suppression par défaut transmise aussitôt (le dossier recopié ne contient plus le fichier) ; différée par
  // `deferDeletions` ; refusée tant qu'une suppression « acceptée mais non propagée » de l'émetteur attend son retour (`accept-not-propagated`
  // du plan) : iCloud ne l'a jamais reçue, le destinataire garde sa version.
  const previous = to.devices.get(deviceId);
  const kept = [...(options.deferDeletions ?? []), ...from.pendingResurrections(deviceId)];
  to.devices.set(deviceId, copy);
  if (previous) for (const name of kept) keepPrevious(previous, copy, name);
  if (options.conflictCopy) to.addStrayEntries(deviceId, 1);
  if (options.placeholder) {
    for (const name of to.fileNames(deviceId)) to.setAvailability(deviceId, name, 'cloud');
  }
  if (options.partialLastLine) {
    // Dernier enregistrement du dernier segment en cours de transfert : ligne sans fin, illisible.
    for (const epochDir of to.devices.get(deviceId)?.epochs.values() ?? []) {
      const file = epochDir.segments.get(Math.max(0, ...epochDir.segments.keys()));
      if (file && file.lines.length > 0) {
        file.lines.pop();
        file.partialTail = true;
      }
    }
  }
}

/** Remet dans `copy` le fichier `name` de la version précédente du destinataire, s'il y était et qu'il manque à la copie. */
function keepPrevious(previous: DeviceDir, copy: DeviceDir, name: string): void {
  if (name === STATE_FILE) {
    if (!copy.state && previous.state) copy.state = structuredClone(previous.state);
    return;
  }
  const [epoch, file] = name.split('/');
  const parsed = file ? parseSyncFileName(file) : null;
  const before = epoch ? previous.epochs.get(epoch as never) : undefined;
  if (!epoch || !before || !parsed || parsed.kind === 'state') return;
  const source = parsed.kind === 'segment' ? before.segments.get(parsed.n) : before.snapshots.get(parsed.n);
  if (!source) return;
  let target = copy.epochs.get(epoch as never);
  if (!target) {
    target = { segments: new Map(), snapshots: new Map() };
    copy.epochs.set(epoch as never, target);
  }
  const map = parsed.kind === 'segment' ? target.segments : target.snapshots;
  if (!map.has(parsed.n)) map.set(parsed.n, structuredClone(source));
}

/**
 * Y-10 : iCloud propage l'état du dossier `devices/<deviceId>/` de `from` vers `to`, **suppression comprise** (dossier d'un appareil
 * oublié supprimé par un appareil actif) : absent chez `from`, il disparaît chez `to` ; présent, il est recopié.
 */
export function mirrorDeviceFolder(from: MemorySyncFolder, to: MemorySyncFolder, deviceId: string): void {
  if (!from.devices.has(deviceId)) {
    to.devices.delete(deviceId);
    return;
  }
  propagate(from, to, deviceId);
}

/** Rend lisibles les fichiers d'un appareil restés dans le nuage (hydratation réussie au cycle suivant). */
export function hydrate(folder: MemorySyncFolder, deviceId: string): void {
  for (const name of folder.fileNames(deviceId)) folder.setAvailability(deviceId, name, 'local');
}

/** Nom d'un segment dans un dossier d'époque (`<époque>/j-0000000n.ctj`). */
export const segmentPath = (epoch: string, n: number): string => `${epoch}/${segmentFileName(n)}`;
