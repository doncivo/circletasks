import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { systemClock } from '../../domain/clock';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import { t } from '../../i18n';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import type { CaptureContextSnapshot, CaptureWindowBridge } from '../../platform/capture';
import { QuickInputField, QuickPreview } from '../../ui';
import { useAppStore } from '../app/appStore';
import { addedMessage } from './captureUseCases';
import { DictationButton, DictationHelp, useDictation } from './Dictation';
import { useQuickInputWithClock } from './useQuickInput';
import './MiniCapture.css';

/** Durée d'affichage de « Ajoutée : <titre> » (Q-01 critère 3). */
export const ADDED_MESSAGE_MS = 3_000;
/** Hauteur de base de la fenêtre (src-tauri/src/capture.rs, DEFAULT_HEIGHT). */
const BASE_HEIGHT = 160;
const LIST_MARGIN = 12;

export interface MiniCaptureProps {
  readonly bridge: CaptureWindowBridge;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Mini-fenêtre de capture rapide (Q-01) : 520 x 160, sans bordure système. Elle n'ouvre pas la base : elle reçoit les espaces et projets
 * de la fenêtre principale (suggestions # et @, aperçu) et lui envoie le texte (`capture:submit`), seule à écrire. Entrée crée et ferme,
 * Ctrl+Entrée crée et reste ouverte (« Ajoutée : <titre> » 3 s), Échap ferme sans rien créer, la perte de focus ferme si le champ est vide.
 * Aucun brouillon n'est conservé : le champ est vidé à chaque ouverture.
 */
export function MiniCapture({ bridge }: MiniCaptureProps) {
  const quick = useQuickInputWithClock(systemClock);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: 'added' | 'error' } | null>(null);
  const [shaking, setShaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef('');
  const resetRef = useRef(quick.reset);
  // Les écouteurs du pont lisent le texte et la remise à zéro courants sans se réabonner à chaque frappe.
  useEffect(() => {
    textRef.current = quick.text;
    resetRef.current = quick.reset;
  });

  const dictation = useDictation({
    layout: 'pc',
    inputRef,
    onText: (spoken) => quick.setText(quick.text === '' ? spoken : `${quick.text} ${spoken}`),
  });

  /** Le champ tremble (titre vide refusé) ; sans animation si l'utilisateur la réduit (CSS). */
  const shakeField = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 450);
  }, []);

  const showMessage = useCallback((text: string, tone: 'added' | 'error') => {
    if (messageTimer.current !== null) clearTimeout(messageTimer.current);
    setMessage({ text, tone });
    messageTimer.current = setTimeout(() => setMessage(null), ADDED_MESSAGE_MS);
  }, []);

  useEffect(
    () => () => {
      if (messageTimer.current !== null) clearTimeout(messageTimer.current);
    },
    [],
  );

  // Contexte de la fenêtre principale : espaces, projets, filtre et premier jour de la semaine (aucune lecture de la base ici).
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    let applied = '';
    const apply = (context: CaptureContextSnapshot): void => {
      const signature = JSON.stringify(context);
      if (signature === applied) return;
      applied = signature;
      const store = useAppStore.getState();
      store.setSpaces(context.spaces);
      store.setProjects(context.projects);
      store.setSpaceFilter(context.spaceFilter);
      setFormatPrefs({ firstWeekday: context.firstWeekday });
    };
    const focusFresh = (): void => {
      resetRef.current();
      setMessage(null);
      setBusy(false);
      inputRef.current?.focus();
      void bridge.requestContext();
    };
    const keep = (promise: Promise<() => void>): void => {
      promise.then(
        (stop) => (disposed ? stop() : stops.push(stop)),
        () => undefined,
      );
    };
    keep(bridge.onContext(apply));
    keep(bridge.onShown(focusFresh));
    // Perte de focus : on ne ferme que si le champ est vide (ne jamais perdre une saisie).
    keep(
      bridge.onBlurred(() => {
        if (textRef.current.trim() === '') void bridge.hide();
      }),
    );
    void bridge.requestContext();
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [bridge]);

  // La liste de suggestions déborde de la carte de 160 px : la fenêtre grandit pour la montrer, puis revient à sa taille.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    let last = BASE_HEIGHT;
    const measure = (): void => {
      const list = card.querySelector<HTMLElement>('[role="listbox"]');
      const body = bodyRef.current;
      const content = body ? body.getBoundingClientRect().bottom + 12 : BASE_HEIGHT;
      const needed = Math.max(BASE_HEIGHT, Math.ceil(Math.max(content, list ? list.getBoundingClientRect().bottom + LIST_MARGIN : 0)));
      if (needed === last) return;
      last = needed;
      void bridge.resize(needed);
    };
    const observer = new MutationObserver(measure);
    observer.observe(card, { childList: true, subtree: true, characterData: true });
    measure();
    return () => observer.disconnect();
  }, [bridge]);

  const submit = useCallback(
    async (chain: boolean): Promise<void> => {
      if (busy) return;
      if (quick.parseNow().title.trim() === '') {
        // Titre vide refusé (T-01) : le champ tremble, la fenêtre reste ouverte.
        shakeField();
        showMessage(t('capture.window.titleEmpty'), 'error');
        return;
      }
      setBusy(true);
      const reply = await bridge.submit({ text: quick.text, ignored: [...quick.ignoredKeys] });
      setBusy(false);
      if (!reply.ok) {
        if (reply.error === 'title-empty') shakeField();
        showMessage(t(reply.error === 'no-space' ? 'capture.window.noSpace' : reply.error === 'title-empty' ? 'capture.window.titleEmpty' : 'capture.window.failed'), 'error');
        return;
      }
      quick.reset();
      if (chain) {
        showMessage(addedMessage(reply.title), 'added');
        inputRef.current?.focus();
      } else {
        setMessage(null);
        await bridge.hide();
      }
    },
    [busy, bridge, quick, showMessage, shakeField],
  );

  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit(event.ctrlKey || event.metaKey);
    }
  }

  // Échap ferme (la liste de suggestions consomme son propre Échap) ; Tab reste dans la fenêtre (piège de focus).
  function onCardKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void bridge.hide();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      ref={cardRef}
      className="ct-mini"
      role="dialog"
      aria-modal="true"
      aria-label={t('capture.window.label')}
      onKeyDown={onCardKeyDown}
    >
      <div ref={bodyRef} className="ct-mini__body">
        <p className="ct-mini__title" aria-hidden="true">
          {t('capture.window.heading')}
        </p>
        <div className="ct-mini__row" data-shake={shaking ? 'true' : undefined}>
          <QuickInputField
            ref={inputRef}
            label={t('tasks.newTask')}
            placeholder={t('capture.window.placeholder')}
            value={quick.text}
            onChange={quick.setText}
            maxLength={TASK_TITLE_MAX_LENGTH}
            context={quick.suggestionContext}
            placement="below"
            className="ct-mini__field"
            autoFocus
            enterKeyHint="done"
            onKeyDown={onFieldKeyDown}
            {...(dictation.helpVisible ? { describedBy: dictation.helpId } : {})}
          />
          <DictationButton dictation={dictation} />
        </div>
        <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={quick.today} onDismiss={quick.dismiss} className="ct-mini__preview" />
        <div className="ct-mini__foot">
          {message ? (
            <p className="ct-mini__message" data-tone={message.tone} role="status">
              {message.text}
            </p>
          ) : (
            <p className="ct-mini__help">{t('capture.window.help')}</p>
          )}
          <DictationHelp dictation={dictation} className="ct-mini__dictation" />
        </div>
      </div>
    </div>
  );
}
