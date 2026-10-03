import { Target, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Goal, IconRef, Space } from '../../domain/model';
import { GOAL_TITLE_MAX_LENGTH } from '../../domain/goalRules';
import type { SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { Icon, IconChooser, IconView, resolveIconRefColor, SpaceSegmented } from '../../ui';
import './GoalsScreen.css';

/** Icône d'un objectif : celle choisie, sinon la cible bleue (#3F7FC4, PRD section 5). */
export function GoalIcon({ icon, size }: { icon: IconRef | null; size: number }) {
  return icon ? <IconView icon={icon} size={size} color={resolveIconRefColor(icon)} /> : <Icon icon={Target} size={size} color="var(--ct-color-goal)" />;
}

interface TitleFieldProps {
  readonly label: string;
  readonly value: string;
  readonly autoFocus?: boolean;
  /** Brouillon d'un objectif à créer : la saisie est vidée une fois l'objectif créé (aucun doublon à la perte de focus). */
  readonly clearOnCommit?: boolean;
  readonly placeholder?: string;
  /** Valide le titre saisi (Entrée ou perte de focus) ; rend true s'il est enregistré (le champ garde alors la saisie). */
  readonly onCommit: (value: string) => Promise<boolean>;
}

/**
 * Champ titre de l'objectif (Objectif.html : bord #3F7FC4, 56 px). Entrée ou perte de focus valide ; un titre refusé (vide) fait
 * revenir l'ancien titre (OB-01 critère 5). Une saisie validée par Entrée n'est pas revalidée par la perte de focus qui suit.
 */
function TitleField({ label, value, autoFocus, clearOnCommit, placeholder, onCommit }: TitleFieldProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  async function commit(): Promise<void> {
    if (busy.current) return;
    if (draft.trim() === value) return;
    busy.current = true;
    try {
      const saved = await onCommit(draft);
      if (!saved || clearOnCommit) setDraft(value);
    } finally {
      busy.current = false;
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void commit();
  }

  return (
    <form className="ct-goal__titleForm" onSubmit={submit}>
      <label className="ct-goal__titleLabel">
        <span className="ct-visually-hidden">{label}</span>
        <input
          ref={inputRef}
          type="text"
          className="ct-goal__field"
          value={draft}
          maxLength={GOAL_TITLE_MAX_LENGTH}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
        />
      </label>
    </form>
  );
}

export interface GoalSectionProps {
  readonly goal: Goal;
  /** Rang (1, 2…) : distingue les libellés accessibles quand la semaine a plusieurs objectifs. */
  readonly index: number;
  readonly spaces: readonly Space[];
  readonly onTitle: (title: string) => Promise<boolean>;
  readonly onIcon: (icon: IconRef | null) => void;
  readonly onSpace: (spaceId: SpaceId) => void;
  readonly onDelete: () => void;
  /** Contenu ajouté sous le titre (épinglage, avancement, tâches) : fourni par les stories suivantes. */
  readonly children?: ReactNode;
  /** Rangée de boutons du bas (« + Ajouter un objectif », « Marquer atteint »). */
  readonly actions?: ReactNode;
}

/** Section d'un objectif (OB-01 critère 6) : icône, titre, espace, suppression, puis le contenu propre à l'objectif. */
export function GoalSection({ goal, index, spaces, onTitle, onIcon, onSpace, onDelete, children, actions }: GoalSectionProps) {
  const [chooserOpen, setChooserOpen] = useState(false);
  return (
    <section className="ct-goal" aria-label={goalLabel(index)} data-goal-id={goal.id}>
      <div className="ct-goal__titleRow">
        <button
          type="button"
          className="ct-goal__iconButton"
          aria-label={t('goals.iconButton')}
          aria-expanded={chooserOpen}
          onClick={() => setChooserOpen((open) => !open)}
        >
          <GoalIcon icon={goal.icon} size={30} />
        </button>
        <TitleField label={goalLabel(index)} value={goal.title} onCommit={onTitle} />
      </div>
      {chooserOpen && <IconChooser value={goal.icon} onChange={onIcon} />}
      <div className="ct-goal__metaRow">
        <SpaceSegmented layout="compact" items={spaces} value={goal.spaceId} onChange={onSpace} label={t('goals.spaceLabel')} />
        <button type="button" className="ct-goal__deleteButton" aria-label={t('goals.deleteGoal')} onClick={onDelete}>
          <Icon icon={Trash2} size={20} />
        </button>
      </div>
      {children}
      {actions && <div className="ct-goal__actions">{actions}</div>}
    </section>
  );
}

/** Libellé accessible du champ titre ; le premier garde le libellé de la maquette. */
export function goalLabel(index: number): string {
  return index <= 1 ? t('goals.titleLabel') : t('goals.titleLabelN', { number: index });
}

export interface GoalDraftProps {
  readonly index: number;
  readonly spaces: readonly Space[];
  readonly defaultSpaceId: SpaceId | null;
  readonly showHelp: boolean;
  /** Crée l'objectif (titre non vide) ; rend true s'il l'est. */
  readonly onCreate: (title: string, spaceId: SpaceId, icon: IconRef | null) => Promise<boolean>;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

/**
 * Objectif pas encore créé (OB-01 critères 2 et 6) : champ vide focalisé, aide « Fixez ce qui compte cette semaine », espace
 * proposé par la règle de T-01. L'objectif n'existe en base qu'une fois un titre valide saisi.
 */
export function GoalDraft({ index, spaces, defaultSpaceId, showHelp, onCreate, children, actions }: GoalDraftProps) {
  const [spaceId, setSpaceId] = useState<SpaceId | null>(defaultSpaceId);
  const [icon, setIcon] = useState<IconRef | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const space = spaceId ?? defaultSpaceId;
  return (
    <section className="ct-goal" aria-label={goalLabel(index)} data-draft="true">
      <div className="ct-goal__titleRow">
        <button type="button" className="ct-goal__iconButton" aria-label={t('goals.iconButton')} aria-expanded={chooserOpen} onClick={() => setChooserOpen((open) => !open)}>
          <GoalIcon icon={icon} size={30} />
        </button>
        <TitleField
          label={goalLabel(index)}
          value=""
          autoFocus
          clearOnCommit
          placeholder={t('goals.titlePlaceholder')}
          onCommit={async (title) => (space ? onCreate(title, space, icon) : false)}
        />
      </div>
      {showHelp && <p className="ct-goal__help">{t('goals.helpEmpty')}</p>}
      {chooserOpen && <IconChooser value={icon} onChange={setIcon} />}
      <div className="ct-goal__metaRow">
        <SpaceSegmented layout="compact" items={spaces} value={space} onChange={setSpaceId} label={t('goals.spaceLabel')} />
      </div>
      {children}
      {actions && <div className="ct-goal__actions">{actions}</div>}
    </section>
  );
}
