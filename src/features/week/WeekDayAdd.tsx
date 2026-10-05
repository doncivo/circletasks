import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatDropDayLabel } from '../../i18n/format';
import { QuickInputField, QuickPreview, type Layout } from '../../ui';
import { captureInputFrom, useQuickInput, type CaptureInput } from '../capture';
import { useEffectiveProjectFilter } from '../spaces';

export interface WeekDayAddProps {
  readonly date: LocalDate;
  readonly layout: Layout;
  /** Crée la tâche du jour ; rend true si elle l'est (le champ se vide et reste ouvert). */
  readonly onAdd: (capture: CaptureInput) => Promise<boolean>;
  /** Appelé après une création : la colonne fait défiler la nouvelle carte à l'écran. */
  readonly onAdded?: () => void;
}

/**
 * Ajout rapide en bas de chaque jour (S-04, PC-Semaine.html : bouton pointillé « + Ajouter »). Un clic le transforme en champ de
 * saisie focalisé (« Nouvelle tâche pour jeu. 24 ») ; Entrée crée la tâche de ce jour, sans heure, et garde le champ ouvert et vide
 * pour la suivante ; Échap, ou quitter un champ vide, le referme sans rien créer. Le titre suit la règle de T-01 (rogné, 1 à 200
 * caractères) ; un champ vide ou d'espaces ne crée rien. Sur iPhone, le champ reste visible au-dessus du clavier.
 * Le texte est analysé comme ailleurs (Q-06, Q-02) : « #perso », « @projet » ; une date ou une heure écrite (« demain 10h »,
 * « 14h ») est annoncée par la pastille et l'emporte sur le jour de la colonne ; sans date écrite, la tâche est de ce jour.
 */
export function WeekDayAdd({ date, layout, onAdd, onAdded }: WeekDayAddProps) {
  const [open, setOpen] = useState(false);
  const quick = useQuickInput();
  const projectFilter = useEffectiveProjectFilter();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const restoreFocus = useRef(false);
  const day = formatDropDayLabel(date);

  // Ouverture : le champ prend le focus ; sur iPhone, la section défile pour que le clavier ne le masque pas.
  useEffect(() => {
    if (!open) return undefined;
    const input = inputRef.current;
    if (!input) return undefined;
    input.focus();
    if (layout !== 'mobile') return undefined;
    // `scrollIntoView` n'existe pas partout (tests jsdom) : sans lui, le champ reste où il est.
    const reveal = (): void => (input as Partial<HTMLInputElement>).scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(reveal, 250); // après l'ouverture du clavier
    window.visualViewport?.addEventListener('resize', reveal);
    return () => {
      window.clearTimeout(timer);
      window.visualViewport?.removeEventListener('resize', reveal);
    };
  }, [open, layout]);

  // Fermeture par Échap : le focus revient au bouton.
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const capture = captureInputFrom(await quick.parseNowLoaded(), quick.defaultSpaceId, projectFilter);
    if (!validateTaskTitle(capture.title).ok || busy.current) return;
    busy.current = true;
    try {
      if (await onAdd(capture)) {
        quick.reset();
        onAdded?.();
        inputRef.current?.focus();
      }
    } finally {
      busy.current = false;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation(); // la fiche ouverte ne se ferme pas avec le champ
    quick.reset();
    restoreFocus.current = true;
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" ref={buttonRef} className="ct-week__add" data-layout={layout} aria-label={t('week.addButton', { day })} onClick={() => setOpen(true)}>
        {t('week.add')}
      </button>
    );
  }
  return (
    <div className="ct-week__addBlock">
      <form className="ct-week__addForm" data-layout={layout} onSubmit={(event) => void submit(event)}>
        <QuickInputField
          ref={inputRef}
          variant="plain"
          inputClassName="ct-week__addInput"
          label={t('week.addLabel', { day })}
          placeholder={t('week.addPlaceholder')}
          value={quick.text}
          onChange={quick.setText}
          maxLength={TASK_TITLE_MAX_LENGTH}
          enterKeyHint="done"
          context={quick.suggestionContext}
          placement="above"
          onKeyDown={onKeyDown}
          // Quitter un champ vide le referme ; un titre commencé reste ouvert.
          onBlur={() => quick.text.trim() === '' && setOpen(false)}
        />
      </form>
      <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={quick.today} onDismiss={quick.dismiss} />
    </div>
  );
}
