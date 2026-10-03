import { Target, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import { goalsOfWeek } from '../../domain/goalRules';
import { addDays } from '../../domain/localDate';
import type { Goal } from '../../domain/model';
import { isoWeekOf } from '../../domain/week';
import { t } from '../../i18n';
import { formatWeekRange } from '../../i18n/format';
import { Button, ConfirmDialog, DetailPanel, Icon, useDetailSlot, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useAnnounceCreation, useDefaultSpaceId } from '../spaces';
import { GoalDraft, GoalSection } from './GoalSection';
import { goalsStore } from './goalsStore';
import './GoalsScreen.css';

/**
 * Écran Objectif (M17, Objectif.html) : iPhone en écran plein avec « Retour », PC en panneau à droite (comme le détail d'une tâche).
 * La semaine en cours (lundi → dimanche) présente une section par objectif (QB-12) ; le filtre d'espace global s'applique aux sections.
 * Sans objectif, un champ vide focalisé invite à fixer ce qui compte (OB-01 critère 2).
 */
export function GoalsScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const slot = useDetailSlot();
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const appDay = useAppStore((s) => s.day);
  const navigate = useNavigationStore((s) => s.navigate);
  const detailOpen = useNavigationStore((s) => s.detail !== null);
  const defaultSpaceId = useDefaultSpaceId();
  const announceCreation = useAnnounceCreation();

  const goals = useFeatureStore(goalsStore, (s) => s.goals);
  const weekStart = useFeatureStore(goalsStore, (s) => s.weekStart);
  const status = useFeatureStore(goalsStore, (s) => s.status);
  const errorKey = useFeatureStore(goalsStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(goalsStore, (s) => s.actionErrorKey);
  const load = useFeatureStore(goalsStore, (s) => s.load);
  const create = useFeatureStore(goalsStore, (s) => s.create);
  const setTitle = useFeatureStore(goalsStore, (s) => s.setTitle);
  const setIcon = useFeatureStore(goalsStore, (s) => s.setIcon);
  const setSpace = useFeatureStore(goalsStore, (s) => s.setSpace);
  const setPinned = useFeatureStore(goalsStore, (s) => s.setPinned);
  const remove = useFeatureStore(goalsStore, (s) => s.remove);

  const today = appDay ?? todayLocal(container.clock);
  useEffect(() => {
    void load(today);
    // `load` ne rejette jamais ; rechargé à l'ouverture et au passage de minuit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const sections = useMemo(() => (weekStart ? goalsOfWeek(goals, weekStart, spaceFilter) : []), [goals, weekStart, spaceFilter]);

  // Brouillons : « + Ajouter un objectif » ouvre une section vide (non créée tant qu'aucun titre valide n'est saisi). Sans objectif
  // affiché, un brouillon implicite (clé 0) tient lieu de champ vide focalisé.
  const [extraDrafts, setExtraDrafts] = useState<readonly number[]>([]);
  const nextDraft = useRef(1);
  const drafts = extraDrafts.length > 0 ? extraDrafts : sections.length === 0 && status === 'ready' ? [0] : [];
  const [toDelete, setToDelete] = useState<Goal | null>(null);

  // PC : la fiche d'une tâche prend la place du panneau tant qu'elle est ouverte.
  if (layout === 'pc' && detailOpen) return null;
  if (!weekStart) return layout === 'pc' ? null : <div className="ct-goals" data-layout={layout} aria-busy="true" />;

  const addButton = (
    <Button variant="secondary" fullWidth onClick={() => setExtraDrafts((current) => (current.length > 0 ? current : [nextDraft.current++]))}>
      {t('goals.addGoal')}
    </Button>
  );
  const total = sections.length + drafts.length;
  const lastKey = drafts.length > 0 ? `draft-${drafts[drafts.length - 1]}` : sections.at(-1)?.id;

  const body = (
    <div className="ct-goals" data-layout={layout}>
      {layout === 'mobile' && (
        <div className="ct-goals__topRow">
          <button type="button" className="ct-goals__iconButton" aria-label={t('goals.back')} onClick={() => navigate({ tab: 'tasks', screen: 'today' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
      )}
      <div className="ct-goals__header">
        <span className="ct-goals__week">{t('goals.weekLine', { number: isoWeekOf(weekStart).week, range: formatWeekRange(weekStart, addDays(weekStart, 6), 'short') })}</span>
        <div className="ct-goals__titleRow">
          <Icon icon={Target} size={40} color="var(--ct-color-goal)" />
          <h1 className="ct-goals__title">{t('goals.title')}</h1>
        </div>
      </div>
      <div className="ct-goals__rule" aria-hidden="true">
        <div className="ct-goals__ruleAccent" />
        <div className="ct-goals__ruleLine" />
      </div>
      {status === 'error' && errorKey && <p className="ct-goals__error" role="alert">{t(errorKey)}</p>}
      {actionErrorKey && <p className="ct-goals__error" role="alert">{t(actionErrorKey)}</p>}
      {status !== 'error' && (
        <div className="ct-goals__sections" aria-busy={status === 'loading'}>
          {sections.map((goal, index) => (
            <GoalSection
              key={goal.id}
              goal={goal}
              index={index + 1}
              spaces={spaces}
              onTitle={async (title) => (await setTitle(goal.id, title)).ok}
              onIcon={(icon) => void setIcon(goal.id, icon)}
              onSpace={(spaceId) => void setSpace(goal.id, spaceId)}
              onPin={(pinned) => void setPinned(goal.id, pinned)}
              onDelete={() => setToDelete(goal)}
              actions={goal.id === lastKey ? addButton : undefined}
            />
          ))}
          {drafts.map((key, offset) => (
            <GoalDraft
              key={`draft-${key}`}
              index={sections.length + offset + 1}
              spaces={spaces}
              defaultSpaceId={defaultSpaceId}
              showHelp={total === 1}
              actions={`draft-${key}` === lastKey ? addButton : undefined}
              onCreate={async (title, spaceId, icon) => {
                const result = await create({ title, spaceId, icon });
                if (!result.ok) return false;
                announceCreation(spaceId);
                setExtraDrafts((current) => current.filter((candidate) => candidate !== key));
                return true;
              }}
            />
          ))}
        </div>
      )}
      {toDelete && (
        <ConfirmDialog
          title={t('goals.deleteTitle', { title: toDelete.title })}
          description={t('goals.deleteDescription')}
          confirmLabel={t('goals.deleteConfirm')}
          onCancel={() => setToDelete(null)}
          onConfirm={() => {
            const id = toDelete.id;
            setToDelete(null);
            void remove(id);
          }}
        />
      )}
    </div>
  );

  if (layout === 'pc') {
    const panel = (
      <DetailPanel label={t('goals.panelLabel')} caption={t('goals.panelCaption')} onClose={() => navigate({ tab: 'tasks', screen: 'today' })} width={588}>
        {body}
      </DetailPanel>
    );
    return slot ? createPortal(panel, slot) : panel;
  }
  return body;
}
