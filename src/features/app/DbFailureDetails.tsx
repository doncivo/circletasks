import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { DB_URL, readDbEnvironment, type DbEnvironment } from '../../platform/dbDiagnostics';
import type { DbFailure } from './appStore';

const OPEN_STEP_LABELS: Readonly<Record<string, () => string>> = {
  runtime: () => t('app.diag.steps.runtime'),
  load: () => t('app.diag.steps.load'),
  pragma: () => t('app.diag.steps.pragma'),
  schema: () => t('app.diag.steps.schema'),
  backup: () => t('app.diag.steps.backup'),
  afterApply: () => t('app.diag.steps.afterApply'),
  other: () => t('app.diag.steps.other'),
};

/** Libellé de l'étape en échec : étapes fines de l'ouverture, ou nom du module pour la suite du démarrage. */
export function failureStepLabel(failure: DbFailure): string {
  if (failure.phase === 'start') return t('app.diag.steps.start', { name: failure.step });
  if (failure.step === 'migration') return t('app.diag.steps.migration', { version: failure.migration === undefined ? '?' : String(failure.migration) });
  const label = Object.hasOwn(OPEN_STEP_LABELS, failure.step) ? OPEN_STEP_LABELS[failure.step] : undefined;
  return label ? label() : `${t('app.diag.steps.other')} (${failure.step})`;
}

/** Copie de la sélection par le système (WebView sans presse-papiers asynchrone) ; false si indisponible. */
function systemCopy(): boolean {
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  }
}

const yesNo =(value: boolean) => t(value ? 'app.diag.yes' : 'app.diag.no');

/** Texte complet du diagnostic, affiché et copié tel quel (une information par ligne). */
export function formatDbFailure(failure: DbFailure, env: DbEnvironment | null): string {
  const lines = [
    t('app.diag.step', { step: failureStepLabel(failure) }),
    t('app.diag.error', { name: failure.errorName, message: failure.message }),
    t('app.diag.url', { url: DB_URL }),
  ];
  if (!env) {
    lines.push(t('app.diag.pathsPending'));
    return lines.join('\n');
  }
  const paths = env.paths;
  if (paths) {
    if (paths.configDir !== null) lines.push(t('app.diag.configDir', { path: paths.configDir, exists: yesNo(paths.dirExists) }));
    if (paths.configDirError !== null) lines.push(t('app.diag.configDirError', { message: paths.configDirError }));
    if (paths.dbPath !== null) {
      lines.push(t('app.diag.dbFile', { path: paths.dbPath, exists: yesNo(paths.fileExists), size: paths.fileBytes === null ? t('app.diag.unknown') : String(paths.fileBytes) }));
      lines.push(t('app.diag.wal', { exists: yesNo(paths.walExists) }));
    }
  }
  if (env.pathsError !== null) lines.push(t('app.diag.pathsError', { message: env.pathsError }));
  lines.push(
    t('app.diag.environment', {
      runtime: env.runtime,
      os: env.os,
      build: env.buildPlatform ?? t('app.diag.unknown'),
      version: env.appVersion ?? t('app.diag.unknown'),
    }),
  );
  return lines.join('\n');
}

/**
 * 0.2.1 : diagnostic d'échec de démarrage, sous le message d'erreur (PC et iPhone). Texte sélectionnable et bouton « Copier le détail »
 * (presse-papiers, sinon sélection + copie du système, sinon invitation à sélectionner le texte).
 */
export function DbFailureDetails({ failure, readEnvironment = readDbEnvironment }: { failure: DbFailure; readEnvironment?: () => Promise<DbEnvironment> }) {
  const [env, setEnv] = useState<DbEnvironment | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let alive = true;
    void readEnvironment().then((value) => {
      if (alive) setEnv(value);
    });
    return () => {
      alive = false;
    };
  }, [readEnvironment]);

  const text = formatDbFailure(failure, env);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
      return;
    } catch {
      // WebView sans presse-papiers asynchrone : sélection puis copie du système.
    }
    const node = pre.current;
    const selection = window.getSelection();
    if (node && selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setCopy(systemCopy() ? 'copied' : 'failed');
  };

  return (
    <section className="ct-db-failure" aria-label={t('app.diag.title')}>
      <pre ref={pre} data-testid="db-failure-detail" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}>
        {text}
      </pre>
      <button type="button" onClick={() => void onCopy()}>
        {t('app.diag.copy')}
      </button>
      {copy !== 'idle' && <p role="status">{t(copy === 'copied' ? 'app.diag.copied' : 'app.diag.copyFailed')}</p>}
    </section>
  );
}
