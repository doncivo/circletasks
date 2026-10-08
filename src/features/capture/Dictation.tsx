import { Mic } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n';
import { logFailure } from '../../platform';
import { getSpeechRecognizer, SpeechError, type SpeechStopReason } from '../../platform/speech';
import { Button, Icon, Sheet, type Layout } from '../../ui';
import { useAppLockStore } from '../security/appLockStore';
import { withExcursion } from '../security/excursion';
import { canOpenAppSettings, openAppSettingsAction } from '../security/systemSettingsAction';
import { deniedTextKey, dictationGate, type DictationGate, type DictationPermission } from './dictationPermission';
import './Dictation.css';

export interface UseDictationOptions {
  readonly layout: Layout;
  /** Champ de saisie qui reçoit le texte (PC : focalisé ; iPhone : le texte reconnu y est ajouté pour relecture). */
  readonly inputRef: RefObject<HTMLInputElement>;
  /** Texte reconnu (iPhone, ordre 5) : l'appelant le pose dans le champ ; jamais de création automatique (Q-03 critère 3). */
  readonly onText: (text: string) => void;
}

type ErrorKey = 'permissionDenied' | 'failed' | 'busy' | 'unavailable' | 'onDeviceUnavailable' | 'unknownState';
type InfoKey = 'nothingHeard' | 'timeLimit' | 'interrupted';

/**
 * Message de la dictée, affiché sous le champ. Refus et erreurs sont **persistants** (`role="alert"`, jusqu'à résolution : prochain appui
 * ou autorisation rendue) ; les infos (rien entendu, limite de 60 s, interruption) s'effacent au prochain appui.
 */
export type DictationNotice =
  | { readonly kind: 'denied'; readonly permission: DictationPermission; readonly restricted: boolean }
  | { readonly kind: 'error'; readonly key: ErrorKey; readonly code?: string }
  | { readonly kind: 'info'; readonly key: InfoKey };

const STOP_INFO: Partial<Record<SpeechStopReason, InfoKey>> = { 'time-limit': 'timeLimit', interrupted: 'interrupted' };

/** Journal technique : code seul (jamais un texte reconnu ni l'état brut d'une autorisation). */
function logSpeech(code: string): void {
  logFailure('capture', code);
}

/**
 * Dictée d'une tâche (Q-03, CAP-IOS-01, I-05). PC : pas de moteur dans l'app, le bouton micro focalise le champ et affiche l'aide « Win + H » ;
 * le texte dicté par Windows arrive comme une saisie ordinaire. iPhone : le bouton de l'app n'existe que si `SpeechRecognizer.isAvailable()`
 * (plugin Speech) ; au premier appui, une feuille explique les deux autorisations AVANT les fenêtres d'iOS, un refus reste visible avec
 * « Ouvrir les réglages », puis la feuille « Je vous écoute » ouvre l'écoute (sur l'appareil, 60 s au plus, arrêtée au passage en
 * arrière-plan et au verrou). Le texte reconnu est posé dans le champ pour relecture : rien n'est créé.
 */
export function useDictation({ layout, inputRef, onText }: UseDictationOptions) {
  const helpId = useId();
  const [speechAvailable, setSpeechAvailable] = useState(false);
  // Service indisponible sur iPhone (plugin absent, refusé ou muet) : code à dire, jamais un micro qui disparaît sans explication.
  const [unavailableCode, setUnavailableCode] = useState<string | null>(null);
  // Modèle français hors ligne absent : dictée désactivée tant qu'il manque, relu au retour au premier plan.
  const [offlineMissing, setOfflineMissing] = useState(false);
  const [helpVisible, setHelpVisible] = useState(false);
  const [listening, setListening] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [notice, setNotice] = useState<DictationNotice | null>(null);
  const [settingsCode, setSettingsCode] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // Un seul démarrage à la fois : lecture de l'état, feuille d'explication, demande des autorisations, écoute.
  const starting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current?.abort();
    };
  }, []);

  // iPhone seulement : le bouton propre à l'app dépend du plugin (jamais disponible sur PC).
  useEffect(() => {
    if (layout === 'pc') return;
    let cancelled = false;
    const recognizer = getSpeechRecognizer();
    const check = recognizer.availability ? recognizer.availability() : recognizer.isAvailable().then((available) => ({ available }));
    check
      .then((result) => {
        if (cancelled) return;
        setSpeechAvailable(result.available);
        setUnavailableCode('code' in result && typeof result.code === 'string' && !result.available ? result.code : null);
      })
      .catch(() => {
        // Le contrat ne rejette pas ; un rejet est un plugin muet : micro non affiché mais DIT, échec au journal.
        logSpeech('speech-plugin-unavailable');
        if (!cancelled) setUnavailableCode('speech-plugin-unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [layout]);

  // Aucune écoute ne continue app masquée ni verrou fermé (CAP-IOS-01 critère 9) : `speech_stop` part par le signal.
  useEffect(() => {
    if (!listening) return undefined;
    const abort = (): void => stop.current?.abort();
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') abort();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = useAppLockStore.subscribe((state) => {
      if (state.phase === 'locked') abort();
    });
    if (useAppLockStore.getState().phase === 'locked' || document.visibilityState === 'hidden') abort();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
    };
  }, [listening]);

  /** Relit l'état des autorisations ; rend la porte correspondante, ou `null` si la lecture a échoué (message posé). */
  const readGate = useCallback(async (): Promise<DictationGate | null> => {
    const recognizer = getSpeechRecognizer();
    if (!recognizer.permissions) return { kind: 'listen' };
    try {
      return dictationGate(await recognizer.permissions());
    } catch (error) {
      if (!mounted.current) return null;
      const code = error instanceof SpeechError && error.code ? error.code : 'speech-status-failed';
      logSpeech(code);
      setNotice({ kind: 'error', key: 'unknownState', code });
      return null;
    }
  }, []);

  const listen = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    stop.current = controller;
    setListening(true);
    let stoppedBy: SpeechStopReason = 'user';
    try {
      const text = await getSpeechRecognizer().listen({
        locale: 'fr-FR',
        stopSignal: controller.signal,
        onStopped: (reason) => {
          stoppedBy = reason;
        },
      });
      if (!mounted.current) return;
      const spoken = text.trim();
      if (spoken !== '') onText(spoken);
      inputRef.current?.focus();
      if (spoken === '') setNotice({ kind: 'info', key: 'nothingHeard' });
      else if (STOP_INFO[stoppedBy]) setNotice({ kind: 'info', key: STOP_INFO[stoppedBy] as InfoKey });
    } catch (error: unknown) {
      if (!mounted.current) return;
      setNotice(noticeOf(error));
    } finally {
      if (mounted.current) setListening(false);
      stop.current = null;
    }
  }, [inputRef, onText]);

  /** Applique la porte : refus nommé, état illisible dit avec son code, explication, ou écoute. */
  const proceed = useCallback(
    async (gate: DictationGate): Promise<void> => {
      switch (gate.kind) {
        case 'denied':
          logSpeech(`speech-permission-${gate.permission}-${gate.restricted ? 'restricted' : 'denied'}`);
          setNotice({ kind: 'denied', permission: gate.permission, restricted: gate.restricted });
          return;
        case 'unknown':
          logSpeech(`speech-permission-unknown-${gate.permission}`);
          setNotice({ kind: 'error', key: 'unknownState', code: `permission-unknown-${gate.permission}` });
          return;
        case 'explain':
          setExplaining(true);
          return;
        case 'listen':
          await listen();
      }
    },
    [listen],
  );

  const press = useCallback(() => {
    if (layout === 'pc') {
      setNotice(null);
      inputRef.current?.focus();
      setHelpVisible(true);
      return;
    }
    if (starting.current || explaining) return;
    starting.current = true;
    setNotice(null);
    setSettingsCode(null);
    void (async () => {
      try {
        // Décision d'Ali : sans le modèle français hors ligne, la dictée est DÉSACTIVÉE (message persistant) AVANT toute explication ou
        // demande d'autorisation : aucune fenêtre d'iOS, aucune écoute.
        const ready = await getSpeechRecognizer()
          .onDeviceReady?.()
          .catch(() => undefined);
        if (!mounted.current) return;
        if (ready === false) {
          logSpeech('speech-on-device-unavailable');
          setOfflineMissing(true);
          setNotice({ kind: 'error', key: 'onDeviceUnavailable' });
          return;
        }
        const gate = await readGate();
        if (gate && mounted.current) await proceed(gate);
      } finally {
        starting.current = false;
      }
    })();
  }, [layout, inputRef, explaining, readGate, proceed]);

  /** « Continuer » : les fenêtres d'iOS (micro, puis reconnaissance vocale) ne s'ouvrent qu'ici (I-05 critères 1 et 6). */
  const continueExplain = useCallback(() => {
    setExplaining(false);
    const recognizer = getSpeechRecognizer();
    const request = recognizer.requestPermissions?.bind(recognizer);
    if (!request) {
      // Contrat violé (reconnaisseur sans demande d'autorisation) : dit avec son code, jamais un « Continuer » muet.
      logSpeech('speech-request-missing');
      setNotice({ kind: 'error', key: 'unknownState', code: 'permission-request-missing' });
      return;
    }
    starting.current = true;
    void (async () => {
      try {
        const states = await withExcursion('permission', request);
        if (!mounted.current) return;
        const gate = dictationGate(states);
        // Après la demande, une autorisation encore non décidée n'a plus de sens : état dit avec son code.
        if (gate.kind === 'explain') {
          logSpeech('speech-permission-undecided');
          setNotice({ kind: 'error', key: 'unknownState', code: 'permission-undecided' });
          return;
        }
        await proceed(gate);
      } catch (error: unknown) {
        if (mounted.current) setNotice(noticeOf(error));
      } finally {
        starting.current = false;
      }
    })();
  }, [proceed]);

  const dismissExplain = useCallback(() => setExplaining(false), []);

  /** « Ouvrir les réglages » (module commun, excursion `system-settings`) ; un échec est dit avec son code. */
  const openSettings = useCallback(async (): Promise<void> => {
    setSettingsCode(null);
    const code = await openAppSettingsAction();
    if (code && mounted.current) setSettingsCode(code);
  }, []);

  // Retour au premier plan (après les Réglages) : l'état est relu du système ; autorisation rendue = message disparu, toujours refusée =
  // message conservé. iOS peut relancer l'app à froid (écart 5 de l'ADR 0015) : l'état est alors relu au prochain appui.
  const blocked = notice?.kind === 'denied';
  useEffect(() => {
    if (layout === 'pc' || !blocked) return undefined;
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void readGate().then((gate) => {
        if (!mounted.current || !gate) return;
        if (gate.kind !== 'denied') {
          setNotice(null);
          setSettingsCode(null);
        }
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [layout, blocked, readGate]);

  // Retour au premier plan : le modèle hors ligne est relu ; présent = message disparu et bouton rétabli.
  useEffect(() => {
    if (layout === 'pc' || !offlineMissing) return undefined;
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void (getSpeechRecognizer().onDeviceReady?.() ?? Promise.resolve(undefined)).then(
        (ready) => {
          if (!mounted.current || ready === false) return;
          setOfflineMissing(false);
          setNotice(null);
        },
        () => undefined,
      );
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [layout, offlineMissing]);

  const finish = useCallback(() => stop.current?.abort(), []);

  return {
    showButton: layout === 'pc' || speechAvailable,
    helpId,
    helpVisible,
    listening,
    explaining,
    notice,
    noticeVisible: notice !== null,
    settingsCode,
    canOpenSettings: layout !== 'pc' && canOpenAppSettings(),
    disabled: offlineMissing,
    unavailableCode: layout !== 'pc' && !speechAvailable ? unavailableCode : null,
    press,
    finish,
    continueExplain,
    dismissExplain,
    openSettings,
    layout,
  };
}

/** Erreur de l'écoute ou de la demande → message (refus nommé quand le plugin dit laquelle ; refus générique du faux de Q-03 sinon). */
function noticeOf(error: unknown): DictationNotice {
  if (!(error instanceof SpeechError)) {
    logSpeech('speech-failed');
    return { kind: 'error', key: 'failed' };
  }
  const code = error.code;
  logSpeech(code ?? `speech-${error.reason}`);
  const withCode = (key: ErrorKey): DictationNotice => (code ? { kind: 'error', key, code } : { kind: 'error', key });
  switch (error.reason) {
    case 'permission-denied':
      return error.permission ? { kind: 'denied', permission: error.permission, restricted: false } : withCode('permissionDenied');
    case 'on-device-unavailable':
      return withCode('onDeviceUnavailable');
    case 'busy':
      return withCode('busy');
    case 'unavailable':
      return withCode('unavailable');
    case 'failed':
      return withCode('failed');
  }
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
      aria-describedby={dictation.helpVisible || dictation.noticeVisible ? dictation.helpId : undefined}
      disabled={dictation.disabled}
      onClick={dictation.press}
    >
      <Icon icon={Mic} size={22} />
    </button>
  );
}

const ERROR_TEXT: Record<ErrorKey, 'capture.dictation.permissionDenied' | 'capture.dictation.failed' | 'capture.dictation.busy' | 'capture.dictation.unavailable' | 'capture.dictation.onDeviceUnavailable' | 'capture.dictation.unknownState'> = {
  permissionDenied: 'capture.dictation.permissionDenied',
  failed: 'capture.dictation.failed',
  busy: 'capture.dictation.busy',
  unavailable: 'capture.dictation.unavailable',
  onDeviceUnavailable: 'capture.dictation.onDeviceUnavailable',
  unknownState: 'capture.dictation.unknownState',
};

const INFO_TEXT: Record<InfoKey, 'capture.dictation.nothingHeard' | 'capture.dictation.timeLimit' | 'capture.dictation.interrupted'> = {
  nothingHeard: 'capture.dictation.nothingHeard',
  timeLimit: 'capture.dictation.timeLimit',
  interrupted: 'capture.dictation.interrupted',
};

/** Aide discrète (PC) ou message de la dictée (iPhone) ; le champ y renvoie par `aria-describedby`. */
export function DictationHelp({ dictation, className }: { readonly dictation: Dictation; readonly className?: string }) {
  const { notice } = dictation;
  const classes = ['ct-dictation__help', className].filter(Boolean).join(' ');
  if (notice === null) {
    if (dictation.unavailableCode) {
      return (
        <p id={dictation.helpId} role="status" className={classes}>
          {`${t('capture.dictation.pluginUnavailable')} ${t('capture.dictation.code', { code: dictation.unavailableCode })}`}
        </p>
      );
    }
    if (!(dictation.helpVisible && dictation.layout === 'pc')) return <span id={dictation.helpId} hidden />;
    return (
      <p id={dictation.helpId} role="status" className={classes}>
        {t('capture.dictation.helpPc')}
      </p>
    );
  }
  if (notice.kind === 'info') {
    return (
      <p id={dictation.helpId} role="status" className={classes}>
        {t(INFO_TEXT[notice.key])}
      </p>
    );
  }
  const text = notice.kind === 'denied' ? t(deniedTextKey(notice.permission, notice.restricted)) : t(ERROR_TEXT[notice.key]);
  const code = notice.kind === 'error' ? notice.code : undefined;
  return (
    <div id={dictation.helpId} role="alert" className={classes}>
      <p className="ct-dictation__message">{code ? `${text} ${t('capture.dictation.code', { code })}` : text}</p>
      {notice.kind === 'denied' && !notice.restricted && dictation.canOpenSettings && (
        <Button variant="secondary" onClick={() => void dictation.openSettings()}>
          {t('capture.dictation.denied.openSettings')}
        </Button>
      )}
      {dictation.settingsCode && <p className="ct-dictation__message">{`${t('capture.dictation.settingsFailed')} ${t('capture.dictation.code', { code: dictation.settingsCode })}`}</p>}
    </div>
  );
}

/** Feuilles de la dictée (iPhone) : explication des autorisations avant les fenêtres d'iOS, puis « Je vous écoute » avec « Terminer ». */
export function ListeningSheet({ dictation }: { readonly dictation: Dictation }) {
  return (
    <>
      <Sheet open={dictation.explaining} onClose={dictation.dismissExplain} label={t('capture.dictation.explain.title')}>
        <div className="ct-dictation__sheet">
          <Icon icon={Mic} size={40} />
          <p className="ct-dictation__explain">{t('capture.dictation.explain.text')}</p>
          <div className="ct-dictation__actions">
            <Button onClick={dictation.continueExplain}>{t('capture.dictation.explain.continue')}</Button>
            <Button variant="secondary" onClick={dictation.dismissExplain}>
              {t('capture.dictation.explain.later')}
            </Button>
          </div>
        </div>
      </Sheet>
      <Sheet open={dictation.listening} onClose={dictation.finish} label={t('capture.dictation.listening')}>
        <div className="ct-dictation__sheet">
          <Icon icon={Mic} size={40} />
          <p className="ct-dictation__listening" role="status">
            {t('capture.dictation.listening')}
          </p>
          <Button onClick={dictation.finish}>{t('capture.dictation.finish')}</Button>
        </div>
      </Sheet>
    </>
  );
}
