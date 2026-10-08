import { Download } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ExportKind } from '../../domain/historyExport';
import { t } from '../../i18n';
import { logFailure } from '../../platform';
import type { FileService } from '../../platform/files';
import { Button, Icon, Sheet, useFocusTrap, useLayout } from '../../ui';
import { FileSaveFailure } from '../app/FileSaveFailure';
import { saveFile } from '../app/saveFile';
import { createExportFile, type ExportContext } from './exportActions';
import type { ExportPeriod } from './exportHistory';
import './ExportDialog.css';

const KINDS: readonly { readonly id: ExportKind; readonly label: 'stats.exportCsv' | 'stats.exportJson' | 'stats.exportPdf' | 'stats.exportPng' }[] = [
  { id: 'csv', label: 'stats.exportCsv' },
  { id: 'json', label: 'stats.exportJson' },
  { id: 'pdf', label: 'stats.exportPdf' },
  { id: 'png', label: 'stats.exportPng' },
];

export interface ExportDialogProps {
  readonly files: FileService;
  readonly context: ExportContext;
  readonly onClose: () => void;
  /** Fichier enregistré (le chemin est connu sur PC). */
  readonly onDone: (path: string | undefined) => void;
}

/** Bouton « Exporter » du rapport (pilule 36 px à contour, comme « Reprendre la photo ») : masqué quand la plateforme ne sait pas enregistrer. */
export function ExportButton({ files, onClick }: { files: FileService; onClick: () => void }) {
  if (!files.canSave()) return null;
  return (
    <button type="button" className="ct-export__button" onClick={onClick}>
      <Icon icon={Download} size={18} />
      <span>{t('stats.exportButton')}</span>
    </button>
  );
}

function Window({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });
  return createPortal(
    <div className="ct-export__backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('stats.exportTitle')} tabIndex={-1} className="ct-export">
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Fenêtre « Exporter l'historique » (H-03 critère 1) : contenu (CSV, JSON, rapport en PDF ou en image), période (CSV et JSON), rappel du
 * filtre d'espace en vigueur et avertissement « non chiffré ». Fenêtre centrée sur PC, feuille sur iPhone. Une annulation de la boîte
 * « Enregistrer sous » ne montre aucune erreur ; un échec affiche un message clair (aucun fichier partiel).
 */
export function ExportDialog({ files, context, onClose, onDone }: ExportDialogProps) {
  const layout = useLayout();
  const [kind, setKind] = useState<ExportKind>('csv');
  const [period, setPeriod] = useState<ExportPeriod>('all');
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle');
  // Code de l'échec (FILES-IOS-01 critère 9) : affiché avec « Réessayer » jusqu'au prochain essai.
  const [failure, setFailure] = useState<{ readonly code: string; readonly tooLarge: boolean }>({ code: 'write-failed', tooLarge: false });
  const history = kind === 'csv' || kind === 'json';
  // Fermer pendant l'export abandonne la suite : ni « Enregistrer sous », ni message de réussite.
  const abandoned = useRef(false);
  const close = (): void => {
    abandoned.current = true;
    onClose();
  };

  async function run(): Promise<void> {
    setStatus('busy');
    try {
      const request = await createExportFile(kind, period, context);
      if (abandoned.current) return;
      // Sélecteur « Enregistrer dans Fichiers » sur iPhone (excursion du verrou), « Enregistrer sous » sur PC ; échec journalisé avec son code.
      const outcome = await saveFile(files, request, 'export-save');
      if (abandoned.current) return;
      if (outcome.status === 'cancelled') {
        setStatus('idle');
        return;
      }
      if (outcome.status === 'failed') {
        setFailure({ code: outcome.code, tooLarge: outcome.tooLarge });
        setStatus('error');
        return;
      }
      onDone(outcome.path);
    } catch (error) {
      // Préparation du fichier (lecture, rendu du rapport) : même message visible, code générique.
      logFailure('export-prepare', error);
      if (!abandoned.current) {
        setFailure({ code: 'write-failed', tooLarge: false });
        setStatus('error');
      }
    }
  }

  const body = (
    <form
      className="ct-export__form"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <h2 className="ct-export__title">{t('stats.exportTitle')}</h2>
      <fieldset className="ct-export__group">
        <legend>{t('stats.exportContent')}</legend>
        {KINDS.map((option) => (
          <label key={option.id} className="ct-export__choice">
            <input type="radio" name="export-kind" checked={kind === option.id} onChange={() => setKind(option.id)} />
            <span>{t(option.label)}</span>
          </label>
        ))}
      </fieldset>
      {history && (
        <fieldset className="ct-export__group">
          <legend>{t('stats.exportPeriod')}</legend>
          <label className="ct-export__choice">
            <input type="radio" name="export-period" checked={period === 'all'} onChange={() => setPeriod('all')} />
            <span>{t('stats.exportPeriodAll')}</span>
          </label>
          <label className="ct-export__choice">
            <input type="radio" name="export-period" checked={period === 'month'} onChange={() => setPeriod('month')} />
            <span>{t('stats.exportPeriodMonth')}</span>
          </label>
        </fieldset>
      )}
      <p className="ct-export__note">{t('stats.exportFilter', { filter: context.filterLabel })}</p>
      {history && <p className="ct-export__note">{t('stats.exportUnencrypted')}</p>}
      {status === 'error' && <FileSaveFailure message={t('stats.exportError')} code={failure.code} tooLarge={failure.tooLarge} onRetry={() => void run()} />}
      {status === 'busy' && (
        <p className="ct-export__note" role="status">
          {t('stats.exportBusy')}
        </p>
      )}
      <div className="ct-export__actions">
        <Button type="submit" disabled={status === 'busy'}>
          {t('stats.exportRun')}
        </Button>
        <Button variant="secondary" onClick={close}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );

  return layout === 'pc' ? (
    <Window onClose={close}>{body}</Window>
  ) : (
    <Sheet open onClose={close} label={t('stats.exportTitle')}>
      {body}
    </Sheet>
  );
}
