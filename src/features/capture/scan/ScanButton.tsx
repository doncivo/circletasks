import { Camera } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../../../i18n';
import { openOcrService } from '../../../platform/ocr';
import { Icon, type Layout } from '../../../ui';
import { lazyScreen } from '../../app/lazyScreens';
import type { ScanDialogProps } from './ScanDialog';
import './ScanDialog.css';

/**
 * Le dialogue de scan (lecture, relecture, moteurs) est un bloc à la demande (PERF-02 : le bundle de départ reste sous 350 Ko). Bloc illisible :
 * message et « Réessayer » de `lazyScreen` (jamais un clic muet) ; préchargé en arrière-plan après le premier rendu.
 */
const ScanDialog = lazyScreen<ScanDialogProps>(() => import('./ScanDialog').then((module) => ({ default: module.ScanDialog })));

/** Vrai si un moteur au moins peut lire du texte sur cet appareil (Windows.Media.Ocr avec le pack français, ou le repli intégré). */
function useOcrAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const { primary, fallback } = openOcrService();
    void Promise.all([primary?.status(), fallback?.status()]).then(([native, embedded]) => {
      if (!cancelled) setAvailable(Boolean(native?.available || embedded?.available));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

/**
 * Bouton « Scan tâches » (Main.html sous le champ sur iPhone, PC-Aujourdhui.html à droite du champ sur PC) : ouvre le scan (Q-04).
 * Masqué si aucun moteur de lecture n'est disponible.
 */
export function ScanButton({ layout }: { readonly layout: Layout }) {
  const available = useOcrAvailable();
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return (
    <>
      <button type="button" className="ct-scan-button" data-layout={layout} onClick={() => setOpen(true)}>
        <Icon icon={Camera} size={18} />
        {t('scan.button')}
      </button>
      {open && <ScanDialog onClose={() => setOpen(false)} />}
    </>
  );
}
