import { Archive, ArchiveRestore, ChevronDown, ChevronUp, Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PROJECT_NAME_MAX_LENGTH, activeProjectsOf, defaultProjectColor } from '../../domain/projectRules';
import { PROJECT_PALETTE } from '../../domain/spaceRules';
import type { Project, Space } from '../../domain/model';
import type { HexColor, ProjectId } from '../../domain/types';
import { t, tDynamic, type MessageKey, type PlainMessageKey } from '../../i18n';
import { ColorSwatches, DragHandle, Icon, TextField, spaceTextColor, useSortable } from '../../ui';
import type { ProjectOutcome } from './spacesStore';

export interface ProjectsSectionProps {
  readonly space: Space;
  /** Projets de l'espace, archivés compris. */
  readonly projects: readonly Project[];
  readonly onCreate: (name: string, color: HexColor) => Promise<ProjectOutcome>;
  readonly onUpdate: (id: ProjectId, patch: { readonly name: string; readonly color: HexColor }) => Promise<ProjectOutcome>;
  readonly onArchive: (id: ProjectId, archived: boolean) => Promise<boolean>;
  readonly onMove: (id: ProjectId, to: { readonly direction: -1 | 1 } | { readonly toIndex: number }) => Promise<boolean>;
}

const NAME_ERRORS: Record<Exclude<ProjectOutcome, 'ok'>, PlainMessageKey> = {
  'empty-name': 'spaces.projectNameEmpty',
  'name-too-long': 'spaces.projectNameTooLong',
  'name-taken': 'spaces.projectNameTaken',
  error: 'spaces.saveError',
};

const colorChoices = () => PROJECT_PALETTE.map((choice) => ({ ...choice, label: tDynamic(`spaces.colors.${choice.id}` as MessageKey) }));

interface ProjectFormProps {
  readonly initialName: string;
  readonly initialColor: HexColor;
  readonly submitLabel: string;
  readonly onSubmit: (name: string, color: HexColor) => Promise<ProjectOutcome>;
  readonly onClose: () => void;
}

/** Nom + couleur d'un projet (création et modification) ; la fenêtre se ferme quand l'écriture réussit. */
function ProjectForm({ initialName, initialColor, submitLabel, onSubmit, onClose }: ProjectFormProps) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<HexColor>(initialColor);
  const [errorKey, setErrorKey] = useState<PlainMessageKey | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const outcome = await onSubmit(name, color);
    if (outcome === 'ok') onClose();
    else setErrorKey(NAME_ERRORS[outcome]);
  }

  return (
    <form className="ct-projects__form" onSubmit={(event) => void submit(event)} noValidate>
      <TextField
        label={t('spaces.projectNameLabel')}
        placeholder={t('spaces.projectNameLabel')}
        value={name}
        onChange={(value) => {
          setName(value);
          setErrorKey(null);
        }}
        maxLength={PROJECT_NAME_MAX_LENGTH + 10}
        autoFocus
      />
      <ColorSwatches label={t('spaces.projectColorGroup')} choices={colorChoices()} value={color} onChange={setColor} />
      {errorKey && (
        <p className="ct-projects__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      <div className="ct-projects__formActions">
        <button type="button" className="ct-projects__button" onClick={onClose}>
          {t('spaces.projectCancel')}
        </button>
        <button type="submit" className="ct-projects__button ct-projects__button--primary">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * Projets d'un espace dans « Espaces et projets » (ES-04) : ajout (nom, couleur de la palette, par défaut celle de l'espace),
 * modification, archivage / désarchivage (un projet archivé n'est plus proposé mais garde ses tâches), ordre par glisser-déposer ou
 * au clavier (↑ / ↓ sur la poignée, Alt+↑ / Alt+↓ aussi) qui règle l'ordre de la liste « Projet ». Écran non dessiné dans les maquettes.
 */
export function ProjectsSection({ space, projects, onCreate, onUpdate, onArchive, onMove }: ProjectsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<ProjectId | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; n: number } | null>(null);
  const active = activeProjectsOf(projects, space.id);
  const archived = projects.filter((project) => project.archived).sort((a, b) => a.sortOrder - b.sortOrder);

  async function move(id: ProjectId, to: { readonly direction: -1 | 1 } | { readonly toIndex: number }): Promise<void> {
    const from = active.findIndex((project) => project.id === id);
    const target = 'direction' in to ? from + to.direction : to.toIndex;
    if (target < 0 || target >= active.length || target === from) return;
    if (await onMove(id, to)) {
      const name = active[from]?.name ?? '';
      setAnnouncement((previous) => ({ text: t('spaces.projectMoved', { name, position: target + 1, total: active.length }), n: (previous?.n ?? 0) + 1 }));
    }
  }

  const sortable = useSortable({ ids: active.map((project) => project.id), onMove: (id, toIndex) => void move(id as ProjectId, { toIndex }) });
  const accent = spaceTextColor(space.color);

  return (
    <section className="ct-projects" aria-label={t('spaces.projectsOf', { space: space.name })}>
      <h3 className="ct-projects__title" style={{ color: accent }}>
        {t('spaces.projectsTitle')}
      </h3>
      {active.length === 0 && archived.length === 0 && !adding && <p className="ct-projects__empty">{t('spaces.projectsEmpty')}</p>}
      {active.length > 0 && (
        <div {...sortable.containerProps} className={`ct-projects__list ${sortable.containerProps.className}`} role="list">
          {active.map((project, index) => (
            <div key={project.id} role="listitem" className="ct-projects__item" {...sortable.itemProps(project.id)}>
              {editingId === project.id ? (
                <ProjectForm
                  initialName={project.name}
                  initialColor={project.color}
                  submitLabel={t('spaces.projectSubmitSave')}
                  onSubmit={(name, color) => onUpdate(project.id, { name, color })}
                  onClose={() => setEditingId(null)}
                />
              ) : (
                <div className="ct-projects__row">
                  <DragHandle
                    label={t('spaces.projectHandle', { name: project.name })}
                    {...sortable.dragProps(project.id, 'handle')}
                    onMoveUp={() => void move(project.id, { direction: -1 })}
                    onMoveDown={() => void move(project.id, { direction: 1 })}
                  />
                  <span className="ct-projects__dot" style={{ background: project.color }} aria-hidden="true" />
                  <span className="ct-projects__name">{project.name}</span>
                  <button type="button" className="ct-projects__iconButton ct-projects__move" aria-label={t('spaces.projectMoveUp', { name: project.name })} disabled={index === 0} onClick={() => void move(project.id, { direction: -1 })}>
                    <Icon icon={ChevronUp} size={20} />
                  </button>
                  <button type="button" className="ct-projects__iconButton ct-projects__move" aria-label={t('spaces.projectMoveDown', { name: project.name })} disabled={index === active.length - 1} onClick={() => void move(project.id, { direction: 1 })}>
                    <Icon icon={ChevronDown} size={20} />
                  </button>
                  <button type="button" className="ct-projects__iconButton" aria-label={t('spaces.projectEdit', { name: project.name })} onClick={() => setEditingId(project.id)}>
                    <Icon icon={Pencil} size={20} />
                  </button>
                  <button type="button" className="ct-projects__iconButton" aria-label={t('spaces.projectArchive', { name: project.name })} onClick={() => void onArchive(project.id, true)}>
                    <Icon icon={Archive} size={20} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <ProjectForm
          initialName=""
          initialColor={defaultProjectColor(space)}
          submitLabel={t('spaces.projectSubmitCreate')}
          onSubmit={onCreate}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="ct-projects__add" onClick={() => setAdding(true)}>
          <Icon icon={Plus} size={20} />
          {t('spaces.projectAdd')}
        </button>
      )}
      {archived.length > 0 && (
        <div className="ct-projects__archived" role="group" aria-label={t('spaces.projectArchivedSection')}>
          <h4 className="ct-projects__archivedTitle">{t('spaces.projectArchivedSection')}</h4>
          {archived.map((project) => (
            <div key={project.id} className="ct-projects__row ct-projects__row--archived">
              <span className="ct-projects__dot" style={{ background: project.color }} aria-hidden="true" />
              <span className="ct-projects__name">{project.name}</span>
              <span className="ct-projects__badge">{t('spaces.projectArchivedBadge')}</span>
              <button type="button" className="ct-projects__iconButton" aria-label={t('spaces.projectUnarchive', { name: project.name })} onClick={() => void onArchive(project.id, false)}>
                <Icon icon={ArchiveRestore} size={20} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div key={announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement?.text}
      </div>
    </section>
  );
}
