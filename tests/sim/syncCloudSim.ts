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
  to.devices.set(deviceId, copy);
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
