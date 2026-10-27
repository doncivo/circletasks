import { parseEpochId } from '../../domain/sync/format';
import { tBackupRestore } from '../../i18n/backupRestoreText';
import { t } from '../../i18n';
import type { BackupVersion } from '../../platform/backup';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { deviceName } from '../sync/syncText';

/**
 * Y-TECH-04 (partie C, critères 18 à 23) : libellés de l'appareil et de l'époque d'une sauvegarde, en fonctions pures (aucune lecture de
 * plateforme, de store ni de base : le contexte est passé en paramètre). Rust ne rend que des identifiants (`deviceId`, `platform`,
 * `epoch`) ; le nom lisible, « Cet appareil », « oublié » et « autre époque » sont décidés ici.
 */

export type BackupDevice = Pick<SyncDeviceStatus, 'deviceId' | 'platform' | 'seen' | 'status'>;

export interface BackupLabelContext {
  /** Identité propre de cet appareil, si connue (sa ligne d'APPAREILS, sinon le réglage local `device.id`). */
  readonly ownId: string | null;
  /** Appareils connus de la synchro, oubliés compris (`SyncStatus.devices`). */
  readonly devices: readonly BackupDevice[];
  /** Époque courante de cet appareil (`sync_meta.epoch`) ; null : inconnue (comparaison impossible). */
  readonly currentEpoch: string | null;
}

export const EMPTY_BACKUP_CONTEXT: BackupLabelContext = { ownId: null, devices: [], currentEpoch: null };

/** Les trois champs de Rust sont-ils fournis ? Faux (champs absents) : le service ne les donne pas, la ligne n'affiche rien de plus. */
export function hasBackupOrigin(version: Pick<BackupVersion, 'deviceId' | 'platform' | 'epoch'>): boolean {
  return version.deviceId !== undefined || version.epoch !== undefined;
}

/**
 * Nom d'un appareil par identifiant : « Cet appareil » pour soi ; « PC 56d4 (oublié) » pour une identité oubliée (plateforme, 4 caractères,
 * mention) ; `deviceName` pour un appareil connu (« PC », « iPhone », « PC 1 » si jumeaux) ; nom neutre et identifiant court si jamais vu ;
 * « Appareil inconnu » sans identifiant. Jamais un identifiant brut seul.
 */
export function backupDeviceLabel(deviceId: string | null | undefined, _platform: string | null | undefined, context: BackupLabelContext): string {
  if (deviceId === null || deviceId === undefined || deviceId === '') return tBackupRestore('originUnknown');
  if (context.ownId !== null && deviceId === context.ownId) return tBackupRestore('originThisDevice');
  const known = context.devices.find((device) => device.deviceId === deviceId);
  if (known?.status === 'forgotten') {
    const named = t('sync.status.deviceNamed', {
      platform: t(known.platform === 'ios' ? 'sync.status.deviceIphone' : 'sync.status.devicePc'),
      short: deviceId.slice(0, 4),
    });
    return `${named} (${tBackupRestore('originForgotten')})`;
  }
  if (known && known.seen !== false) return deviceName(known, context.devices);
  // Une sauvegarde d'origine inconnue doit garder son identifiant de secours ; elle n'a pas la sous-ligne d'identité d'APPAREILS.
  // La plateforme enregistrée dans la sauvegarde est un texte libre : ne pas en déduire un nom de plateforme connu.
  return t('sync.forget.unseenName', { short: deviceId.slice(0, 8) });
}

/** Même règle pour l'ouvreur d'une époque ; sa propre identité se lit « cet appareil » (dans la phrase, pas en tête). */
function openerLabel(opener: string, context: BackupLabelContext): string | null {
  if (context.ownId !== null && opener === context.ownId) return tBackupRestore('epochOpenerThisDevice');
  const known = context.devices.find((device) => device.deviceId === opener);
  return known ? backupDeviceLabel(opener, known.platform, context) : null;
}

export interface BackupEpochLabel {
  /** « époque 1, ouverte par PC » ; « époque 1 » si l'ouvreur n'est pas un appareil connu ; null : aucune mention. */
  readonly text: string | null;
  /** « autre époque » : l'époque diffère de l'époque courante ; faux si la comparaison est impossible. */
  readonly other: boolean;
}

export function backupEpochLabel(epoch: string | null | undefined, context: BackupLabelContext): BackupEpochLabel {
  if (epoch === null || epoch === undefined || epoch === '') return { text: null, other: false };
  const other = context.currentEpoch !== null && context.currentEpoch !== epoch;
  const parsed = parseEpochId(epoch);
  if (!parsed) return { text: null, other };
  const base = `${tBackupRestore('epochWord')} ${String(parsed.n)}`;
  const opener = openerLabel(parsed.opener, context);
  return { text: opener === null ? base : `${base}, ${tBackupRestore('epochOpenedBy')} ${opener}`, other };
}

export interface BackupOriginLabels {
  readonly device: string;
  readonly epoch: string | null;
  readonly otherEpoch: string | null;
}

/** Libellés de la ligne d'une sauvegarde ; null quand le service ne fournit pas l'origine (champs absents). */
export function backupOriginLabels(version: Pick<BackupVersion, 'deviceId' | 'platform' | 'epoch'>, context: BackupLabelContext): BackupOriginLabels | null {
  if (!hasBackupOrigin(version)) return null;
  const epoch = backupEpochLabel(version.epoch, context);
  return {
    device: backupDeviceLabel(version.deviceId, version.platform, context),
    epoch: epoch.text,
    otherEpoch: epoch.other ? tBackupRestore('epochOther') : null,
  };
}

/** Nom accessible de la ligne : date et heure, appareil, époque (et « autre époque »), puis le détail déjà présent. */
export function backupRowName(parts: { readonly when: string; readonly origin: BackupOriginLabels | null; readonly details: string; readonly tag: string | null }): string {
  const { origin } = parts;
  return [parts.when, origin?.device, origin?.epoch, origin?.otherEpoch, parts.details, parts.tag].filter((part): part is string => typeof part === 'string' && part !== '').join(', ');
}
