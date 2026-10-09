import { tLogs } from '../../../i18n/logsText';
import type { LogEntry } from '../../../platform/logs';

export interface LogExportMeta {
  readonly version: string;
  readonly os: 'windows' | 'ios' | 'other';
  readonly schemaVersion: number;
  /** Instant de l'export (horloge injectée). */
  readonly now: Date;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `AAAA-MM-JJ HH:MM:SS` en UTC d'un instant ISO ; l'instant tel quel s'il est illisible. */
function utcStamp(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** Décalage local `+02:00` (heure locale = UTC + décalage). */
function offsetOf(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Nom du fichier : `circletasks-logs-AAAAMMJJ-HHMM.txt` (heure locale). */
export function logExportName(now: Date): string {
  return `circletasks-logs-${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
}

/** Ligne d'une entrée : `AAAA-MM-JJ HH:MM:SS scope code détail` (UTC), suivie de `×n` pour des entrées fusionnées. */
export function logExportLine(entry: LogEntry): string {
  const parts = [utcStamp(entry.at), entry.scope, entry.code];
  if (entry.detail) parts.push(entry.detail);
  if (entry.n !== undefined && entry.n >= 2) parts.push(tLogs('repeated', { count: entry.n }));
  return parts.join(' ');
}

/**
 * Fichier texte exporté (I-04 critère 7) : en-tête (application, version, système, version de schéma, date, nombre d'entrées, mention
 * « Ce fichier ne contient ni titres ni notes »), puis une ligne par entrée, de la plus ancienne à la plus récente, heures UTC avec le
 * décalage local indiqué en en-tête. UTF-8, fins de ligne CRLF (lisible dans le Bloc-notes).
 */
export function buildLogExport(entries: readonly LogEntry[], meta: LogExportMeta): { readonly name: string; readonly text: string } {
  const os = meta.os === 'windows' ? tLogs('osWindows') : meta.os === 'ios' ? tLogs('osIos') : tLogs('osOther');
  const local = `${String(meta.now.getFullYear())}-${pad(meta.now.getMonth() + 1)}-${pad(meta.now.getDate())} ${pad(meta.now.getHours())}:${pad(meta.now.getMinutes())}`;
  const header = [
    tLogs('fileTitle'),
    tLogs('fileApp', { version: meta.version }),
    tLogs('fileSystem', { os }),
    tLogs('fileSchema', { schema: meta.schemaVersion }),
    tLogs('fileDate', { date: local }),
    tLogs('fileTimes', { offset: offsetOf(meta.now) }),
    tLogs('fileCount', { count: entries.length }),
    tLogs('filePrivacy'),
    '',
  ];
  const lines = [...header, ...entries.map(logExportLine)];
  return { name: logExportName(meta.now), text: `${lines.join('\r\n')}\r\n` };
}
