import { Camera, ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { t } from '../../../i18n';
import { Button, Icon, type Layout } from '../../../ui';
import { captureFrame, startWebcam, stopWebcam, WebcamError, type WebcamFailure } from './prepareImage';
import type { Scan } from './useScan';

const PC_ACCEPT = 'image/jpeg,image/png,image/webp';

const REFUSALS = {
  heic: 'scan.refusal.heic',
  unsupported: 'scan.refusal.unsupported',
  'too-large': 'scan.refusal.tooLarge',
  unreadable: 'scan.refusal.unreadable',
} as const;

const WEBCAM_ERRORS: Record<WebcamFailure, 'scan.source.webcamDenied' | 'scan.source.webcamNone' | 'scan.source.webcamFailed'> = {
  denied: 'scan.source.webcamDenied',
  none: 'scan.source.webcamNone',
  failed: 'scan.source.webcamFailed',
};

/**
 * Choix de la source (Q-04 critères 2 et 13). PC : « Importer une image » (JPEG, PNG, WebP ; HEIC refusé avec un message ; 10 Mo au plus),
 * « Utiliser la webcam » (aperçu puis « Prendre la photo »), glisser-déposer sur la fenêtre. iPhone : le sélecteur du système
 * (`<input type="file" accept="image/*">` : appareil photo ou photothèque). La webcam ne démarre qu'après un clic explicite.
 */
export function ScanSource({ scan, layout }: { readonly scan: Scan; readonly layout: Layout }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [webcamError, setWebcamError] = useState<WebcamFailure | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Branche le flux sur l'aperçu ; coupe la caméra à la fermeture de l'écran (voyant éteint).
  useEffect(() => {
    streamRef.current = stream;
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  // Écran démonté pendant la demande d'accès : le flux obtenu après coup est coupé aussitôt (voyant éteint).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopWebcam(streamRef.current);
    };
  }, []);

  function onFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void scan.readImage(file);
  }

  async function openWebcam(): Promise<void> {
    setWebcamError(null);
    try {
      const opened = await startWebcam();
      if (!mounted.current) {
        stopWebcam(opened);
        return;
      }
      // Double clic : le flux précédent est coupé avant d'en garder un autre (jamais deux caméras ouvertes).
      stopWebcam(streamRef.current);
      streamRef.current = opened;
      setStream(opened);
    } catch (error) {
      if (!mounted.current) return;
      setWebcamError(error instanceof WebcamError ? error.reason : 'failed');
    }
  }

  function closeWebcam(): void {
    stopWebcam(stream);
    setStream(null);
  }

  async function takePhoto(): Promise<void> {
    if (!video.current) return;
    try {
      const photo = await captureFrame(video.current);
      closeWebcam();
      void scan.readImage(photo);
    } catch {
      closeWebcam();
      setWebcamError('failed');
    }
  }

  const pc = layout === 'pc';
  return (
    <div className="ct-scan__step">
      <h1 className="ct-scan__title">{t('scan.source.title')}</h1>
      <p className="ct-scan__lead">{t('scan.source.hint')}</p>
      {scan.refusal && (
        <p className="ct-scan__alert" role="alert">
          {t(REFUSALS[scan.refusal])}
        </p>
      )}
      {webcamError && (
        <p className="ct-scan__alert" role="alert">
          {t(WEBCAM_ERRORS[webcamError])}
        </p>
      )}

      <input
        ref={fileInput}
        type="file"
        className="ct-visually-hidden"
        accept={pc ? PC_ACCEPT : 'image/*'}
        aria-label={t('scan.source.fileInput')}
        tabIndex={-1}
        onChange={onFile}
      />

      {stream ? (
        <div className="ct-scan__webcam">
          <video ref={video} className="ct-scan__video" autoPlay playsInline muted aria-label={t('scan.source.webcamPreview')} />
          <div className="ct-scan__actions">
            <Button onClick={() => void takePhoto()}>{t('scan.source.takePhoto')}</Button>
            <Button variant="secondary" onClick={closeWebcam}>
              {t('scan.source.stopWebcam')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="ct-scan__sources">
            <button type="button" className="ct-scan__source" onClick={() => fileInput.current?.click()}>
              <Icon icon={ImagePlus} size={26} />
              <span>{t(pc ? 'scan.source.importImage' : 'scan.source.pickPhoto')}</span>
            </button>
            {pc && (
              <button type="button" className="ct-scan__source" onClick={() => void openWebcam()}>
                <Icon icon={Camera} size={26} />
                <span>{t('scan.source.webcam')}</span>
              </button>
            )}
          </div>
          {pc && (
            <div className="ct-scan__drop" aria-hidden="true">
              <span>{t('scan.source.drop')}</span>
              <span className="ct-scan__dropHint">{t('scan.source.formats')}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
