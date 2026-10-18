import type { EpochCarryCause } from '../../domain/sync/epochCarryReport';
import { carryReportKind, shortRowId } from '../../domain/sync/epochCarryReportView';
import type { DeviceId } from '../../domain/types';
import { formatDayMonthYear, formatTime } from '../../i18n/format';
import { tCarry, type SyncCarryReportTextKey } from '../../i18n/syncCarryReportText';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { deviceName } from './syncText';

/**
 * Y-TECH-05 : mises en forme de l'écran du compte rendu du changement d'époque. Textes dans le catalogue à la demande (`tCarry`) ; dates
 * en heure locale, heures dans le format choisi (24 h par défaut), appareils nommés comme dans APPAREILS.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Date et heure locales d'un instant ISO, déjà formatées (« 18 oct. 2026 », « 08:02 »). */
export function carryDateTime(iso: string): { readonly date: string; readonly time: string } {
  const d = new Date(iso);
  return { date: formatDayMonthYear(`${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`), time: formatTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`) };
}

/**
 * Nom d'un appareil du compte rendu : « Cet appareil » pour soi (l'appareil qui a reporté est toujours celui de ce compte rendu), nom de
 * APPAREILS sinon, « (oublié) » pour une identité oubliée, « Appareil {8 caractères} » pour une identité inconnue de la liste.
 */
export function carryDeviceName(id: DeviceId, reporter: DeviceId, devices: readonly SyncDeviceStatus[]): string {
  if (id === reporter) return tCarry('thisDevice');
  const device = devices.find((d) => d.deviceId === id);
  if (!device) return tCarry('unknownDevice', { short: String(id).slice(0, 8) });
  if (device.self) return tCarry('thisDevice');
  const name = deviceName(device, devices);
  return device.status === 'forgotten' ? tCarry('forgottenDevice', { device: name }) : name;
}

export function carryCauseText(cause: EpochCarryCause): string {
  return tCarry(cause === 'restore' ? 'causeRestore' : cause === 'concurrent' ? 'causeConcurrent' : 'causeReset');
}

/** Type d'élément en français (« Tâche », « Projet »…) d'après la clé de la correspondance de `src/domain`. */
export function carryKindText(table: string): string {
  const kind = carryReportKind(table);
  return tCarry(`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as SyncCarryReportTextKey);
}

/** Libellé d'une ligne : titre ou nom, sinon « (sans titre) » et identifiant abrégé. */
export function carryLabelText(label: string | null, rowId: string): string {
  return label ?? tCarry('untitled', { id: shortRowId(rowId) });
}
