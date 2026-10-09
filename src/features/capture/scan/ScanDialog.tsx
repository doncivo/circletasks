import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useMemo, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../i18n';
import { openOcrService, type OcrService } from '../../../platform/ocr';
import { Button, ConfirmDialog, Icon, useFocusTrap, useLayout } from '../../../ui';
import { ScanReview } from './ScanReview';
import { ScanSource } from './ScanSource';
import { isTransientFailure, useScan, type Scan, type ScanFailure, type UnavailableReason } from './useScan';
import './ScanDialog.css';

export interface ScanDialogProps {
  readonly onClose: () => void;
  /** Moteurs de lecture ; absent : ceux de l'appareil (`openOcrService`), libérés à la fermeture. Fourni par les tests. */
  readonly service?: OcrService;
}

/** Moteur de lecture de l'iPhone (Vision) indisponible : raison et code visibles, repli au choix de l'utilisateur (CAP-IOS-01 critère 17). */
function UnavailableIos({ scan, reason }: { readonly scan: Scan; readonly reason: UnavailableReason }) {
  return (
    <div className="ct-scan__step">
      <h1 className="ct-scan__title">{t('scan.unavailableIos.title')}</h1>
      <p className="ct-scan__lead">{t(reason === 'language-missing' ? 'scan.unavailableIos.languageHint' : 'scan.unavailableIos.pluginHint')}</p>
      <p className="ct-scan__alert" role="alert">
        {scan.recheck === 'still-missing' ? `${t('scan.unavailableIos.stillMissing')} ` : ''}
        {t('scan.code', { code: `vision-${reason}` })}
      </p>
      <div className="ct-scan__actions">
        {scan.canUseFallback && <Button onClick={scan.chooseFallbackEngine}>{t('scan.unavailableIos.useFallback')}</Button>}
        <Button variant="secondary" disabled={scan.recheck === 'running'} onClick={() => void scan.recheckEngine()}>
          {scan.recheck === 'running' ? t('scan.unavailable.rechecking') : t('scan.unavailable.recheck')}
        </Button>
      </div>
    </div>
  );
}

const CAUSES = {
  failed: 'scan.visionError.hint',
  unavailable: 'scan.visionError.hint',
  timeout: 'scan.visionError.cause.timeout',
  busy: 'scan.visionError.cause.busy',
  'unsupported-format': 'scan.visionError.cause.unsupportedFormat',
  'too-large': 'scan.visionError.cause.tooLarge',
  dimensions: 'scan.visionError.cause.dimensions',
  'language-missing': 'scan.visionError.hint',
} as const;

/** Lecture refusée par Vision : erreur persistante avec son code, « Réessayer » et « Lire avec le moteur intégré » (jamais de repli silencieux). */
function VisionError({ scan, failure }: { readonly scan: Scan; readonly failure: ScanFailure }) {
  // Erreur passagère : « Réessayer ». Erreur de l'image (format, poids, dimensions) : jamais de « Réessayer » qui reboucle.
  const transient = isTransientFailure(failure.reason);
  return (
    <div className="ct-scan__step ct-scan__step--center">
      <h1 className="ct-scan__title">{t('scan.visionError.title')}</h1>
      <p className="ct-scan__lead">{t(CAUSES[failure.reason])}</p>
      <p className="ct-scan__alert" role="alert">
        {t('scan.code', { code: failure.code })}
      </p>
      <div className="ct-scan__actions">
        {transient ? (
          <>
            <Button onClick={scan.retry}>{t('scan.visionError.retry')}</Button>
            {scan.canUseFallback && (
              <Button variant="secondary" onClick={scan.chooseFallbackEngine}>
                {t('scan.visionError.useFallback')}
              </Button>
            )}
            <Button variant="secondary" onClick={scan.goToSource}>
              {t('scan.review.retake')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={scan.goToSource}>{t('scan.review.retake')}</Button>
            {scan.canUseFallback && (
              <Button variant="secondary" onClick={scan.chooseFallbackEngine}>
                {t('scan.visionError.useFallback')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Unavailable({ scan }: { readonly scan: Scan }) {
  if (scan.unavailableReason) return <UnavailableIos scan={scan} reason={scan.unavailableReason} />;
  return (
    <div className="ct-scan__step">
      <h1 className="ct-scan__title">{t('scan.unavailable.title')}</h1>
      <p className="ct-scan__lead">{t('scan.unavailable.hint')}</p>
      <ol className="ct-scan__steps" aria-label={t('scan.unavailable.steps')}>
        <li>{t('scan.unavailable.step1')}</li>
        <li>{t('scan.unavailable.step2')}</li>
        <li>{t('scan.unavailable.step3')}</li>
        <li>{t('scan.unavailable.step4')}</li>
      </ol>
      {scan.recheck === 'still-missing' && (
        <p className="ct-scan__alert" role="alert">
          {t('scan.unavailable.stillMissing')}
        </p>
      )}
      <div className="ct-scan__actions">
        <Button disabled={scan.recheck === 'running'} onClick={() => void scan.recheckEngine()}>
          {scan.recheck === 'running' ? t('scan.unavailable.rechecking') : t('scan.unavailable.recheck')}
        </Button>
        {scan.canUseFallback && (
          <Button variant="secondary" onClick={scan.chooseFallbackEngine}>
            {t('scan.unavailable.useFallback')}
          </Button>
        )}
      </div>
    </div>
  );
}

function Message({ title, hint, scan, busy }: { readonly title: string; readonly hint?: string; readonly scan?: Scan; readonly busy?: boolean }) {
  return (
    <div className="ct-scan__step ct-scan__step--center" role={busy ? 'status' : undefined}>
      {busy && <Icon icon={LoaderCircle} size={36} className="ct-scan__spinner" />}
      <h1 className="ct-scan__title">{title}</h1>
      {hint && <p className="ct-scan__lead">{hint}</p>}
      {scan && (
        <div className="ct-scan__actions">
          <Button onClick={scan.goToSource}>{t('scan.review.retake')}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Scan de tâches (Q-04) : fenêtre modale de 640 px sur PC, écran plein sur iPhone. Parcours : vérification du moteur (premier scan),
 * source (fichier, webcam, glisser-déposer), lecture, relecture obligatoire (cases à cocher, Scan.html), création en lot annulable.
 * Fermer (croix, Échap) après des corrections demande confirmation ; rien n'est créé tant que « Créer N tâches » n'est pas pressé.
 */
export function ScanDialog({ onClose, service }: ScanDialogProps) {
  const layout = useLayout();
  const own = useMemo(() => service ?? openOcrService(), [service]);
  const scan = useScan({ service: own, onClose });
  const trap = useFocusTrap<HTMLDivElement>({ active: !scan.confirmClose, onEscape: scan.requestClose });

  // Le worker de tesseract.js (mémoire) est libéré à la fermeture ; les moteurs fournis de l'extérieur ne sont pas les nôtres.
  useEffect(
    () => () => {
      if (!service) void own.dispose();
    },
    [own, service],
  );

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && scan.step === 'source') void scan.readImage(file);
  }

  let body;
  switch (scan.step) {
    case 'checking':
      body = <Message title={t('scan.checking')} busy />;
      break;
    case 'unavailable':
      body = <Unavailable scan={scan} />;
      break;
    case 'source':
      body = <ScanSource scan={scan} layout={layout} />;
      break;
    case 'reading':
      body = <Message title={t('scan.reading.title')} hint={t('scan.reading.hint')} busy />;
      break;
    case 'empty':
      body = <Message title={t('scan.empty.title')} hint={t('scan.empty.hint')} scan={scan} />;
      break;
    case 'error':
      body =
        scan.failure?.engine === 'vision' ? (
          <VisionError scan={scan} failure={scan.failure} />
        ) : (
          <Message title={t('scan.error.title')} hint={t('scan.error.hint')} scan={scan} />
        );
      break;
    case 'review':
      body = <ScanReview scan={scan} layout={layout} />;
      break;
  }

  return createPortal(
    <div className="ct-scan__backdrop" data-layout={layout}>
      <div
        ref={trap}
        role="dialog"
        aria-modal="true"
        aria-label={t('scan.dialogLabel')}
        tabIndex={-1}
        className="ct-scan"
        data-layout={layout}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <header className="ct-scan__header">
          <button type="button" className="ct-scan__close" aria-label={t('scan.cancel')} onClick={scan.requestClose}>
            <Icon icon={X} size={24} />
          </button>
          <span className="ct-scan__heading">{t('scan.heading')}</span>
          <span className="ct-scan__headerSpacer" />
        </header>
        {body}
      </div>
      {scan.confirmClose && (
        <ConfirmDialog
          title={t('scan.confirmClose.title')}
          description={t('scan.confirmClose.message')}
          confirmLabel={t('scan.confirmClose.confirm')}
          cancelLabel={t('scan.confirmClose.keep')}
          onConfirm={onClose}
          onCancel={() => scan.setConfirmClose(false)}
        />
      )}
    </div>,
    document.body,
  );
}
