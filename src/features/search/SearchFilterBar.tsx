import { useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { activeProjectsOf, effectiveProjectFilter, isProjectFilterAvailable } from '../../domain/projectRules';
import { SEARCH_KINDS, type SearchKind } from '../../domain/search';
import { hasActiveSearchFilters, type SearchPeriod, type SearchStatusFilter } from '../../domain/searchFilters';
import type { LocalDate, ProjectId, SpaceFilter } from '../../domain/types';
import { t } from '../../i18n';
import { formatDayLabel, formatWeekRange } from '../../i18n/format';
import { DatePrompt, DropdownSelect, type DropdownOption } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { searchStore } from './searchStore';

/** Ordre des types dans le menu « Type » (RC-02 critère 3) : Tous, Tâches, Routines, Événements, Checklists, Objectifs. */
const KIND_MENU_ORDER: readonly SearchKind[] = ['task', 'routine', 'event', 'checklist', 'goal'];

const PERIOD_LABEL = {
  week: 'search.filters.periodWeek',
  month: 'search.filters.periodMonth',
  last30: 'search.filters.periodLast30',
} as const;

function periodText(period: SearchPeriod): string {
  if (period.kind !== 'custom') return t(PERIOD_LABEL[period.kind]);
  const [from, to] = period.from <= period.to ? [period.from, period.to] : [period.to, period.from];
  return from === to ? formatDayLabel(from) : formatWeekRange(from, to, 'short');
}

interface ChipProps {
  /** Texte visible de la puce (« Type : Tous »). */
  readonly text: string;
  readonly active: boolean;
  readonly options: readonly DropdownOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** Puce de filtre : liste native recouvrant une pastille (roue sur iPhone, menu déroulant au clavier sur PC) ; active : #2E2150 / blanc. */
function Chip({ text, active, options, value, onChange }: ChipProps) {
  return (
    <span className="ct-search__chip" data-active={active ? 'true' : 'false'}>
      <DropdownSelect variant="pill" label={t('search.filters.chipLabel', { chip: text })} display={text} options={options} value={value} onChange={onChange} />
    </span>
  );
}

/**
 * Puces de filtre de la recherche (Recherche.html, RC-02) : Espace, Projet (seulement pour un espace unique qui a des projets),
 * Type, Statut, Période ; « Réinitialiser » quand l'une est active. Les filtres sont ceux de la recherche (`searchStore`) : le filtre
 * d'espace global n'est jamais modifié d'ici (critère 7).
 */
export function SearchFilterBar() {
  const container = useAppContainer();
  const filters = useFeatureStore(searchStore, (s) => s.filters);
  const setFilters = useFeatureStore(searchStore, (s) => s.setFilters);
  const resetFilters = useFeatureStore(searchStore, (s) => s.resetFilters);
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const day = useAppStore((s) => s.day);
  const today: LocalDate = day ?? todayLocal(container.clock);
  /** Étape de « Choisir des dates » : première date (début), puis seconde (fin). */
  const [picking, setPicking] = useState<{ readonly step: 'from' } | { readonly step: 'to'; readonly from: LocalDate } | null>(null);

  const spaceName = filters.space === 'all' ? t('search.filters.spaceAll') : (spaces.find((space) => space.id === filters.space)?.name ?? t('search.filters.spaceAll'));
  const projectId = effectiveProjectFilter(filters.space, filters.projectId, projects);
  const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;

  const kindText = t(`search.filters.kind`, { value: filters.kind ? t(`search.groups.${filters.kind}`) : t('search.filters.kindAll') });
  const statusValue = filters.status === 'todo' ? t('search.filters.statusTodo') : filters.status === 'done' ? t('search.filters.statusDone') : t('search.filters.statusAll');
  const period = filters.period;
  const periodValue = period?.kind ?? '';

  const periodOptions: DropdownOption[] = [
    { value: '', label: t('search.filters.periodAny') },
    { value: 'week', label: t('search.filters.periodWeek') },
    { value: 'month', label: t('search.filters.periodMonth') },
    { value: 'last30', label: t('search.filters.periodLast30') },
    { value: 'custom', label: period?.kind === 'custom' ? periodText(period) : t('search.filters.periodCustom') },
    ...(period?.kind === 'custom' ? [{ value: 'edit', label: t('search.filters.periodEdit') }] : []),
  ];

  function choosePeriod(value: string): void {
    if (value === '') void setFilters({ period: null });
    else if (value === 'week' || value === 'month' || value === 'last30') void setFilters({ period: { kind: value } });
    else if (value === 'custom' || value === 'edit') setPicking({ step: 'from' });
  }

  return (
    <div className="ct-search__filters" role="group" aria-label={t('search.filters.group')}>
      <Chip
        text={t('search.filters.space', { value: spaceName })}
        active={filters.space !== 'all'}
        options={[{ value: 'all', label: t('search.filters.spaceAll') }, ...spaces.map((space) => ({ value: space.id as string, label: space.name }))]}
        value={filters.space}
        onChange={(value) => void setFilters({ space: value as SpaceFilter })}
      />
      {isProjectFilterAvailable(filters.space, projects) && (
        <Chip
          text={t('search.filters.project', { value: project ? project.name : t('search.filters.projectAll') })}
          active={project !== undefined}
          options={[{ value: '', label: t('search.filters.projectOptionAll') }, ...activeProjectsOf(projects, filters.space).map((candidate) => ({ value: candidate.id as string, label: candidate.name }))]}
          value={projectId ?? ''}
          onChange={(value) => void setFilters({ projectId: value === '' ? null : (value as ProjectId) })}
        />
      )}
      <Chip
        text={kindText}
        active={filters.kind !== null}
        options={[{ value: '', label: t('search.filters.kindAll') }, ...KIND_MENU_ORDER.filter((kind) => SEARCH_KINDS.includes(kind)).map((kind) => ({ value: kind as string, label: t(`search.groups.${kind}`) }))]}
        value={filters.kind ?? ''}
        onChange={(value) => void setFilters({ kind: value === '' ? null : (value as SearchKind) })}
      />
      <Chip
        text={t('search.filters.status', { value: statusValue })}
        active={filters.status !== null}
        options={[
          { value: '', label: t('search.filters.statusAll') },
          { value: 'todo', label: t('search.filters.statusTodo') },
          { value: 'done', label: t('search.filters.statusDone') },
        ]}
        value={filters.status ?? ''}
        onChange={(value) => void setFilters({ status: value === '' ? null : (value as SearchStatusFilter) })}
      />
      <Chip
        text={period ? t('search.filters.periodValue', { value: periodText(period) }) : t('search.filters.period')}
        active={period !== null}
        options={periodOptions}
        value={periodValue}
        onChange={choosePeriod}
      />
      {hasActiveSearchFilters(filters) && (
        <button type="button" className="ct-search__reset" onClick={() => void resetFilters()}>
          {t('search.filters.reset')}
        </button>
      )}

      {/* « Choisir des dates » : deux sélecteurs de date (T-14), début puis fin ; les deux dates sont remises dans l'ordre. */}
      <DatePrompt
        open={picking?.step === 'from'}
        label={t('search.filters.fromTitle')}
        confirmLabel={t('search.filters.next')}
        today={today}
        initialValue={period?.kind === 'custom' ? period.from : today}
        onConfirm={(date) => {
          if (date) setPicking({ step: 'to', from: date });
        }}
        onClose={() => setPicking(null)}
      />
      <DatePrompt
        open={picking?.step === 'to'}
        label={t('search.filters.toTitle')}
        confirmLabel={t('search.filters.apply')}
        today={today}
        initialValue={picking?.step === 'to' ? picking.from : today}
        onConfirm={(date) => {
          if (picking?.step === 'to' && date) void setFilters({ period: { kind: 'custom', from: picking.from, to: date } });
          setPicking(null);
        }}
        onClose={() => setPicking(null)}
      />
    </div>
  );
}
