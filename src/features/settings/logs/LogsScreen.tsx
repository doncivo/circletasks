import { Download, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { migrations } from '../../../db/migrations';
import { getLocale, t } from '../../../i18n';
import { tLogs } from '../../../i18n/logsText';
import { categoryOf, type LogCategory, type LogEntry, type LogJournal } from '../../../platform/logs';
import { Button, ConfirmDialog, Icon, useLayout } from '../../../ui';
import { useAppContainer } from '../../app/AppContainerContext';
import { FileSaveFailure } from '../../app/FileSaveFailure';
import { useNavigationStore } from '../../app/navigation';
import { saveFile } from '../../app/saveFile';
import { buildLogExport } from './logExport';
import { useLogJournal, useLogStatus } from './useLogJournal';
import './LogsScreen.css';

type Filter = 'all' | LogCategory;

const FILTERS: readonly { readonly id: Filter; readonly label: 'filterAll' | 'filterSync' | 'filterNotifications' | 'filterErrors' }[] = [
  { id: 'all', label: 'filterAll' },
  { id: 'sync', label: 'filterSync' },
  { id: 'notifications', label: 'filterNotifications' },
  { id: 'errors', label: 'filterErrors' },
];

function localTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}

export interface LogsScreenProps {
  /** Journal à afficher (tests) ; celui installé au démarrage par défaut. */
  readonly journal?: LogJournal;
  /** Version de l'app pour l'en-tête de l'export (tests) ; lue sur la plateforme par défaut. */
  readonly version?: () => Promise<string>;
}

/**
 * Écran Logs (I-04, ADR 0014 §4), ouvert depuis Réglages › À PROPOS (PC et iPhone). Aucune maquette : composants existants (titre avec retour,
 * pastilles de filtre, lignes de 13 px, « Exporter » en pilule de 36 px comme H-03, « Effacer » en rouge avec confirmation).
 * Liste de la plus récente à la plus ancienne (500 au plus), heure locale 24 h ; `role="log"` non annoncé en continu.
 * Aucun échec silencieux : un échec d'écriture ou de lecture du journal est affiché en rouge avec son code (critère 10).
 */
export function LogsScreen({ journal: injected, version }: LogsScreenProps = {}) {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const installed = useLogJournal();
  const journal = injected ?? installed.journal;
  const unavailable = injected ? null : installed.unavailable;
  const status = useLogStatus(journal);
  const [entries, setEntries] = useState<readonly LogEntry[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);
  const [exportFailure, setExportFailure] = useState<{ readonly code: string; readonly tooLarge: boolean } | null>(null);
  const [clearFailure, setClearFailure] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // Lecture du journal (et relecture après « Effacer ») ; `read` ne rejette jamais (repli sur la session).
  useEffect(() => {
    if (!journal) return undefined;
    let active = true;
    void journal.read().then((list) => {
      if (active) setEntries(list);
    });
    return () => {
      active = false;
    };
  }, [journal, refresh]);

  const shown = useMemo(() => {
    const list = (entries ?? []).filter((entry) => filter === 'all' || categoryOf(entry.scope) === filter);
    return [...list].reverse();
  }, [entries, filter]);

  async function runExport(): Promise<void> {
    if (!journal) return;
    setBusy(true);
    setExported(false);
    setExportFailure(null);
    try {
      const all = await journal.read();
      const readVersion = version ?? (() => (container.desktop ? container.desktop.getVersion() : import('../../../platform/logs').then((m) => m.appVersion(container.platform.runtime))));
      const appVersion = await readVersion().catch(() => '?');
      const file = buildLogExport(all, { version: appVersion, os: container.platform.os, schemaVersion: migrations.at(-1)?.version ?? 0, now: new Date(container.clock.nowMs()) });
      const outcome = await saveFile(container.files, { suggestedName: file.name, mime: 'text/plain', data: new TextEncoder().encode(file.text) }, 'logs-export');
      if (outcome.status === 'saved') setExported(true);
      if (outcome.status === 'failed') setExportFailure({ code: outcome.code, tooLarge: outcome.tooLarge });
    } finally {
      setBusy(false);
    }
  }

  async function runClear(): Promise<void> {
    if (!journal) return;
    setConfirming(false);
    setBusy(true);
    setClearFailure(null);
    try {
      await journal.clear();
      setExported(false);
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      setClearFailure(typeof code === 'string' ? code : 'io');
    } finally {
      setRefresh((value) => value + 1);
      setBusy(false);
    }
  }

  return (
    <div className="ct-logs-shell" data-layout={layout}>
      <div className="ct-logs">
        <div className="ct-logs__topRow">
          <button type="button" className="ct-logs__back" aria-label={tLogs('back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 ref={titleRef} tabIndex={-1} className="ct-logs__title">
          {tLogs('title')}
        </h1>
        {status.writeError && (
          <p className="ct-logs__error" role="alert">
            {tLogs('writeError')} {tLogs('errorCode', { code: status.writeError })}
          </p>
        )}
        {status.readError && (
          <p className="ct-logs__error" role="alert">
            {tLogs('readError')} {tLogs('errorCode', { code: status.readError })}
          </p>
        )}
        {clearFailure && (
          <p className="ct-logs__error" role="alert">
            {tLogs('clearError')} {tLogs('errorCode', { code: clearFailure })}
          </p>
        )}
        {unavailable && (
          <div className="ct-logs__failure" role="alert">
            <p className="ct-logs__error">
              {tLogs('unavailable')} {tLogs('errorCode', { code: unavailable })}
            </p>
            <Button variant="secondary" onClick={installed.retry}>
              {t('files.retry')}
            </Button>
          </div>
        )}
        {!container.files.canSave() && <p className="ct-logs__note">{tLogs('exportUnavailable')}</p>}
        <div className="ct-logs__actions">
          {container.files.canSave() && (
            <button type="button" className="ct-logs__export" onClick={() => void runExport()} disabled={busy || !journal}>
              <Icon icon={Download} size={18} />
              <span>{tLogs('export')}</span>
            </button>
          )}
          <button type="button" className="ct-logs__clear" onClick={() => setConfirming(true)} disabled={busy || !journal}>
            <Icon icon={Trash2} size={18} />
            <span>{tLogs('clear')}</span>
          </button>
        </div>
        {exportFailure && <FileSaveFailure message={tLogs('exportError')} code={exportFailure.code} tooLarge={exportFailure.tooLarge} disabled={busy} onRetry={() => void runExport()} />}
        <p className="ct-logs__note" role="status">
          {exported ? tLogs('exportDone') : ''}
        </p>
        <div className="ct-logs__filters" role="group" aria-label={tLogs('filtersLabel')}>
          {FILTERS.map((option) => (
            <button key={option.id} type="button" className="ct-logs__filter" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>
              {tLogs(option.label)}
            </button>
          ))}
        </div>
        {entries === null && unavailable ? null : entries === null ? (
          <p className="ct-logs__note">{tLogs('loading')}</p>
        ) : shown.length === 0 ? (
          <p className="ct-logs__empty">{tLogs('empty')}</p>
        ) : (
          <ol className="ct-logs__list" role="log" aria-live="off" aria-label={tLogs('listLabel')}>
            {shown.map((entry, index) => (
              <li key={`${entry.at}-${String(index)}`} className="ct-logs__entry">
                <span className="ct-logs__time">{localTime(entry.at)}</span> <span className="ct-logs__scope">{entry.scope}</span> <span className="ct-logs__code">{entry.code}</span>
                {entry.detail && <span className="ct-logs__detail"> {entry.detail}</span>}
                {entry.n !== undefined && entry.n >= 2 && <span className="ct-logs__count"> {tLogs('repeated', { count: entry.n })}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {confirming && <ConfirmDialog title={tLogs('clearTitle')} description={tLogs('clearMessage')} confirmLabel={tLogs('clearConfirm')} onCancel={() => setConfirming(false)} onConfirm={() => void runClear()} />}
    </div>
  );
}
