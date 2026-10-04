import { Mic } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n';
import { getSpeechRecognizer, SpeechError } from '../../platform/speech';
import { Button, Icon, Sheet, type Layout } from '../../ui';
import './Dictation.css';

export interface UseDictationOptions {
  readonly layout: Layout;
  /** Champ de saisie qui reçoit le texte (PC : focalisé ; iPhone : le texte reconnu y est ajouté pour relecture). */
  readonly inputRef: RefObject<HTMLInputElement>;
  /** Texte reconnu (iPhone, ordre 5) : l'appelant le pose dans le champ ; jamais de création automatique (Q-03 critère 3). */
  readonly onText: (text: string) => void;
}

/**
 * Dictée d'une tâche (Q-03). PC : pas de moteur dans l'app, le bouton micro focalise le champ et affiche l'aide « Win + H » ; le texte dicté
 * par Windows arrive comme une saisie ordinaire. iPhone : le micro du clavier iOS suffit ; le bouton de l'app n'existe que si
 * `SpeechRecognizer.isAvailable()` (plugin Speech, ordre 5) et ouvre la feuille « Je vous écoute ».
 */
export function useDictation({ layout, inputRef, onText }: UseDictationOptions) {
  const helpId = useId();
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const [errorKey, setErrorKey] = useState<'permissionDenied' | 'failed' | null>(null);
  const stop = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current?.abort();
    };
  }, []);

  // iPhone seulement : le bouton propre à l'app dépend du plugin (jamais disponible à l'ordre 3).
  useEffect(() => {
    if (layout === 'pc') return;
    let cancelled = false;
    getSpeechRecognizer()
      .isAvailable()
      .then((available) => {
        if (!cancelled) setSpeechAvailable(available);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [layout]);

  const press = useCallback(() => {
    setErrorKey(null);
    if (layout === 'pc') {
      inputRef.current?.focus();
      setHelpVisible(true);
      return;
    }
    const controller = new AbortController();
    stop.current = controller;
    setListening(true);
    getSpeechRecognizer()
      .listen({ locale: 'fr-FR', stopSignal: controller.signal })
      .then((text) => {
        if (!mounted.current) return;
        const spoken = text.trim();
        if (spoken !== '') onText(spoken);
        inputRef.current?.focus();
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setErrorKey(error instanceof SpeechError && error.reason === 'permission-denied' ? 'permissionDenied' : 'failed');
      })
      .finally(() => {
        if (mounted.current) setListening(false);
        stop.current = null;
      });
  }, [layout, inputRef, onText]);

  const finish = useCallback(() => stop.current?.abort(), []);

  return {
    showButton: layout === 'pc' || speechAvailable,
    helpId,
    helpVisible,
    listening,
    errorKey,
    press,
    finish,
    layout,
  };
}

export type Dictation = ReturnType<typeof useDictation>;

/** Bouton micro de 44 x 44 (Lucide au trait), nommé « Dicter », atteignable au clavier. */
export function DictationButton({ dictation, className }: { readonly dictation: Dictation; readonly className?: string }) {
  if (!dictation.showButton) return null;
  return (
    <button
      type="button"
      className={['ct-dictation__button', className].filter(Boolean).join(' ')}
      aria-label={t('capture.dictation.button')}
      aria-describedby={dictation.helpVisible ? dictation.helpId : undefined}
      onClick={dictation.press}
    >
      <Icon icon={Mic} size={22} />
    </button>
  );
}

/** Aide discrète (PC) ou message d'erreur (iPhone) ; le champ y renvoie par `aria-describedby`. */
export function DictationHelp({ dictation, className }: { readonly dictation: Dictation; readonly className?: string }) {
  const text = dictation.errorKey
    ? t(dictation.errorKey === 'permissionDenied' ? 'capture.dictation.permissionDenied' : 'capture.dictation.failed')
    : dictation.helpVisible && dictation.layout === 'pc'
      ? t('capture.dictation.helpPc')
      : null;
  if (text === null) return <span id={dictation.helpId} hidden />;
  return (
    <p id={dictation.helpId} role={dictation.errorKey ? 'alert' : 'status'} className={['ct-dictation__help', className].filter(Boolean).join(' ')}>
      {text}
    </p>
  );
}

/** Feuille « Je vous écoute » (iPhone, plugin Speech) avec « Terminer ». */
export function ListeningSheet({ dictation }: { readonly dictation: Dictation }) {
  return (
    <Sheet open={dictation.listening} onClose={dictation.finish} label={t('capture.dictation.listening')}>
      <div className="ct-dictation__sheet">
        <Icon icon={Mic} size={40} />
        <p className="ct-dictation__listening" role="status">
          {t('capture.dictation.listening')}
        </p>
        <Button onClick={dictation.finish}>{t('capture.dictation.finish')}</Button>
      </div>
    </Sheet>
  );
}
