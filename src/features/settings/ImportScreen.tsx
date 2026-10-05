import { AlertTriangle, FileUp, Undo2, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ImportRowWarning, UndatedTarget } from '../../domain/csvImport';
import { t } from '../../i18n';
import { formatDayLabel, formatTime } from '../../i18n/format';
import { Button, Icon, SegmentedControl, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { importStore, rejectReasonText } from './importStore';
import './ImportScreen.css';

/** Lignes du tableau d'aperçu, des rejets et des avertissements affichées (le reste : rapport et compteurs). */
export const PREVIEW_ROWS = 20;

/** Singulier pour 0 et 1 (français), pluriel au-delà. */
function plural(count: number, one: 'importCsv.toImportOne' | 'importCsv.rejectedOne' | 'importCsv.warningsOne', many: 'importCsv.toImport' | 'importCsv.rejected' | 'importCsv.warnings'): string {
  return count <= 1 ? t(one, { count }) : t(many, { count });
}

function warningText(item: ImportRowWarning): string {
  return item.warning.code === 'project-unknown'
    ? t('importCsv.warningProjectUnknown', { line: item.line, value: item.warning.value })
    : t('importCsv.warningNoteTruncated', { line: item.line });
}

/**
 * Écran « Importer des tâches » (P-07), ouvert depuis Réglages › DONNÉES ET SÉCURITÉ. Non dessiné : aperçu en tableau et compteurs dans le
 * style de la relecture de Scan.html (ambre pour les avertissements, rouge pour les rejets, motifs en toutes lettres), bouton principal de 56 px.
 * Étapes : choix du fichier -> aperçu (compteurs, 20 premières lignes, rejets, avertissements) -> import -> message avec « Voir dans
 * Aujourd'hui » (l'annulation 5 s est le bandeau « Annuler » commun, Ctrl+Z).
 */
export function ImportScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const goToToday = useNavigationStore((s) => s.goToToday);
  const step = useFeatureStore(importStore, (s) => s.step);
  const preview = useFeatureStore(importStore, (s) => s.preview);
  const undated = useFeatureStore(importStore, (s) => s.undated);
  const progress = useFeatureStore(importStore, (s) => s.progress);
  const importedCount = useFeatureStore(importStore, (s) => s.importedCount);
  const errorKey = useFeatureStore(importStore, (s) => s.errorKey);
  const savedKey = useFeatureStore(importStore, (s) => s.savedKey);
  const choose = useFeatureStore(importStore, (s) => s.choose);
  const setUndated = useFeatureStore(importStore, (s) => s.setUndated);
  const run = useFeatureStore(importStore, (s) => s.run);
  const downloadTemplate = useFeatureStore(importStore, (s) => s.downloadTemplate);
  const downloadReport = useFeatureStore(importStore, (s) => s.downloadReport);
  const reset = useFeatureStore(importStore, (s) => s.reset);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const canSave = container.files.canSave();

  useEffect(() => {
    reset();
  }, [reset]);

  // Accessibilité (critère 14) : le titre reçoit le focus quand l'aperçu ou le résultat remplace l'étape précédente.
  useEffect(() => {
    if (step === 'preview' || step === 'done') titleRef.current?.focus();
  }, [step]);

  const validation = preview?.validation;
  const validCount = validation?.valid.length ?? 0;
  const rejectedCount = validation?.rejected.length ?? 0;
  const warningCount = (validation?.warnings.length ?? 0) + (preview && preview.duplicates > 0 ? 1 : 0);
  const busy = step === 'reading' || step === 'importing';

  return (
    <div className="ct-import-shell" data-layout={layout}>
      <div className="ct-import">
        <div className="ct-import__topRow">
          <button type="button" className="ct-import__back" aria-label={t('importCsv.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 ref={titleRef} tabIndex={-1} className="ct-import__title">
          {t('importCsv.title')}
        </h1>
        {errorKey && (
          <p className="ct-import__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        {/* Région d'annonce montée en permanence (sans nom accessible) : les lecteurs d'écran n'annoncent que le texte ajouté à une région
            déjà présente ; les compteurs y apparaissent avec l'aperçu et sont aussi visibles. */}
        <p className="ct-import__counters" role="status">
          {(step === 'preview' || step === 'importing') && validation
            ? [plural(validCount, 'importCsv.toImportOne', 'importCsv.toImport'), plural(rejectedCount, 'importCsv.rejectedOne', 'importCsv.rejected'), plural(warningCount, 'importCsv.warningsOne', 'importCsv.warnings')].join(' · ')
            : ''}
        </p>
        {savedKey && (
          <p className="ct-import__note" role="status">
            {t(savedKey)}
          </p>
        )}

        {(step === 'idle' || step === 'reading') && (
          <>
            <p className="ct-import__text">{t('importCsv.intro')}</p>
            <h2 className="ct-import__section">{t('importCsv.columnsTitle')}</h2>
            <p className="ct-import__code" translate="no">
              {t('importCsv.columns')}
            </p>
            <p className="ct-import__note">{t('importCsv.columnsHelp')}</p>
            <div className="ct-import__actions">
              <Button onClick={() => void choose()} disabled={busy} className="ct-import__primary">
                <Icon icon={FileUp} size={20} />
                {t('importCsv.choose')}
              </Button>
              {canSave && (
                <Button variant="secondary" onClick={() => void downloadTemplate()} disabled={busy}>
                  {t('importCsv.template')}
                </Button>
              )}
            </div>
            {step === 'reading' && (
              <p className="ct-import__note" role="status">
                {t('importCsv.reading')}
              </p>
            )}
          </>
        )}

        {(step === 'preview' || step === 'importing') && preview && validation && (
          <>
            <p className="ct-import__note">{t('importCsv.fileName', { name: preview.fileName })}</p>
            {preview.table.ignored.length > 0 && <p className="ct-import__note">{t('importCsv.ignoredColumns', { names: preview.table.ignored.join(', ') })}</p>}
            <div className="ct-import__field">
              <span className="ct-import__label">{t('importCsv.undatedLabel')}</span>
              <SegmentedControl<UndatedTarget>
                label={t('importCsv.undatedLabel')}
                value={undated}
                onChange={(value) => void setUndated(value)}
                disabled={busy}
                options={[
                  { value: 'today', label: t('importCsv.undatedToday') },
                  { value: 'someday', label: t('importCsv.undatedSomeday') },
                ]}
              />
            </div>
            {preview.duplicates > 0 && (
              <p className="ct-import__warning">
                <Icon icon={AlertTriangle} size={18} />
                <span>{preview.duplicates === 1 ? t('importCsv.duplicatesOne') : t('importCsv.duplicates', { count: preview.duplicates })}</span>
              </p>
            )}

            {validCount === 0 ? (
              <p className="ct-import__note">{t('importCsv.noValid')}</p>
            ) : (
              <>
                <div className="ct-import__tableWrap">
                  <table className="ct-import__table">
                    <caption className="ct-import__caption">{t('importCsv.previewCaption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('importCsv.colTitle')}</th>
                        <th scope="col">{t('importCsv.colDate')}</th>
                        <th scope="col">{t('importCsv.colTime')}</th>
                        <th scope="col">{t('importCsv.colSpace')}</th>
                        <th scope="col">{t('importCsv.colProject')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.valid.slice(0, PREVIEW_ROWS).map((draft) => (
                        <tr key={draft.line}>
                          <td>{draft.title}</td>
                          <td>{draft.someday ? t('importCsv.someday') : draft.date ? formatDayLabel(draft.date) : ''}</td>
                          <td>{draft.time ? formatTime(draft.time) : ''}</td>
                          <td>{draft.spaceName}</td>
                          <td>{draft.projectName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {validCount > PREVIEW_ROWS && <p className="ct-import__note">{validCount - PREVIEW_ROWS === 1 ? t('importCsv.moreRowsOne') : t('importCsv.moreRows', { count: validCount - PREVIEW_ROWS })}</p>}
              </>
            )}

            {rejectedCount > 0 && (
              <section className="ct-import__block ct-import__block--danger" aria-labelledby="ct-import-rejected">
                <h2 id="ct-import-rejected" className="ct-import__blockTitle">
                  <Icon icon={XCircle} size={18} />
                  {t('importCsv.rejectedTitle')}
                </h2>
                <ul className="ct-import__list">
                  {validation.rejected.slice(0, PREVIEW_ROWS).map((row) => (
                    <li key={row.line}>{t('importCsv.rejectedLine', { line: row.line, reason: rejectReasonText(row.reason) })}</li>
                  ))}
                </ul>
                {rejectedCount > PREVIEW_ROWS && <p className="ct-import__note">{rejectedCount - PREVIEW_ROWS === 1 ? t('importCsv.rejectedMoreOne') : t('importCsv.rejectedMore', { count: rejectedCount - PREVIEW_ROWS })}</p>}
                {canSave && (
                  <Button variant="secondary" onClick={() => void downloadReport()} disabled={busy}>
                    {t('importCsv.downloadReport')}
                  </Button>
                )}
              </section>
            )}

            {validation.warnings.length > 0 && (
              <section className="ct-import__block ct-import__block--warning" aria-labelledby="ct-import-warnings">
                <h2 id="ct-import-warnings" className="ct-import__blockTitle">
                  <Icon icon={AlertTriangle} size={18} />
                  {t('importCsv.warningsTitle')}
                </h2>
                <ul className="ct-import__list">
                  {validation.warnings.slice(0, PREVIEW_ROWS).map((item, index) => (
                    <li key={`${String(item.line)}-${String(index)}`}>{warningText(item)}</li>
                  ))}
                </ul>
                {validation.warnings.length > PREVIEW_ROWS && (
                  <p className="ct-import__note">{validation.warnings.length - PREVIEW_ROWS === 1 ? t('importCsv.warningsMoreOne') : t('importCsv.warningsMore', { count: validation.warnings.length - PREVIEW_ROWS })}</p>
                )}
              </section>
            )}

            {step === 'importing' && progress && (
              <p className="ct-import__note" role="status">
                {t('importCsv.importing', { done: progress.done, total: progress.total })}
              </p>
            )}
            <div className="ct-import__actions">
              <Button onClick={() => void run()} disabled={validCount === 0 || busy} className="ct-import__primary">
                {validCount === 1 ? t('importCsv.importActionOne') : t('importCsv.importAction', { count: validCount })}
              </Button>
              <Button variant="secondary" onClick={() => void choose()} disabled={busy}>
                {t('importCsv.chooseAnother')}
              </Button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <p className="ct-import__done" role="status">
              {importedCount === 1 ? t('importCsv.doneOne') : t('importCsv.done', { count: importedCount })}
            </p>
            <p className="ct-import__note">{t('importCsv.trashHint')}</p>
            <div className="ct-import__actions">
              <Button onClick={goToToday} className="ct-import__primary">
                {t('importCsv.seeToday')}
              </Button>
              <Button variant="secondary" onClick={reset}>
                {t('importCsv.another')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
