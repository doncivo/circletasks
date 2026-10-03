import { useCallback, useEffect, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { ConfirmDialog, DatePrompt, DropdownSelect, Fab, SpacePills, useLayout } from '../../ui';
import { checklistProgress } from '../../domain/checklistRules';
import type { ChecklistId } from '../../domain/types';
import { t } from '../../i18n';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useAnnounceCreation, useDefaultSpaceId, useEffectiveProjectFilter } from '../spaces';
import { ChecklistDateRow } from './ChecklistDateRow';
import { ChecklistDetail } from './ChecklistDetail';
import { ChecklistEditorHost } from './ChecklistEditorHost';
import { ChecklistForm } from './ChecklistForm';
import { ChecklistTemplateRows } from './ChecklistTemplateRows';
import { ChecklistList } from './ChecklistList';
import { checklistsStore } from './checklistsStore';
import type { NewChecklistInput } from './checklistUseCases';
import './Checklists.css';

/**
 * Onglet Checklists (M6, Checklists.html, PC-Checklists.html) : iPhone, pastille « Choisir une checklist » puis le détail ; PC, volet
 * gauche de 380 px (pastilles d'espace, liste, « + Nouvelle checklist ») et détail à droite. La checklist affichée est la route
 * (`checklistId`) : elle est conservée d'un onglet à l'autre (`lastRoutes`) ; à défaut, la première de la liste.
 */
export function ChecklistsScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const projectFilter = useEffectiveProjectFilter();
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const routeId = route.tab === 'checklists' ? route.checklistId : null;

  const summaries = useFeatureStore(checklistsStore, (s) => s.summaries);
  const itemsFor = useFeatureStore(checklistsStore, (s) => s.itemsFor);
  const compact = useFeatureStore(checklistsStore, (s) => s.compact);
  const items = useFeatureStore(checklistsStore, (s) => s.items);
  const status = useFeatureStore(checklistsStore, (s) => s.status);
  const errorKey = useFeatureStore(checklistsStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(checklistsStore, (s) => s.actionErrorKey);
  const load = useFeatureStore(checklistsStore, (s) => s.load);
  const select = useFeatureStore(checklistsStore, (s) => s.select);
  const create = useFeatureStore(checklistsStore, (s) => s.create);
  const update = useFeatureStore(checklistsStore, (s) => s.update);
  const remove = useFeatureStore(checklistsStore, (s) => s.remove);
  const setDate = useFeatureStore(checklistsStore, (s) => s.setDate);
  const duplicate = useFeatureStore(checklistsStore, (s) => s.duplicate);
  const addItem = useFeatureStore(checklistsStore, (s) => s.addItem);
  const toggleItem = useFeatureStore(checklistsStore, (s) => s.toggleItem);
  const renameItem = useFeatureStore(checklistsStore, (s) => s.renameItem);
  const setCompact = useFeatureStore(checklistsStore, (s) => s.setCompact);

  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [datePromptOpen, setDatePromptOpen] = useState(false);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const [deleteTarget, setDeleteTarget] = useState<ChecklistId | null>(null);
  /** Checklist qui reçoit le focus dans « Ajouter un élément » dès qu'elle est affichée (après sa création). */
  const [focusRequest, setFocusRequest] = useState<ChecklistId | null>(null);
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);
  const defaultSpaceId = useDefaultSpaceId();
  const announceCreation = useAnnounceCreation();

  // Sous un filtre projet, aucune checklist (elles n'ont pas de projet, ES-04).
  const visible = projectFilter ? [] : summaries;
  const displayed = visible.find((summary) => summary.checklist.id === routeId) ?? visible[0] ?? null;
  const displayedId = (displayed?.checklist.id ?? null) as ChecklistId | null;

  useEffect(() => {
    void load(spaceFilter);
    // `load` ne rejette jamais ; recharge au changement de filtre d'espace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter]);

  useEffect(() => {
    void select(displayedId);
  }, [displayedId, select]);

  /** C-04 : crée la copie décochée, sans date, et l'ouvre. */
  async function duplicateDisplayed(): Promise<void> {
    if (!displayed) return;
    const copy = await duplicate(displayed.checklist.id as ChecklistId);
    if (!copy) return;
    choose(copy.id as ChecklistId);
    closeEditor();
  }

  const choose = useCallback((id: ChecklistId) => navigate({ tab: 'checklists', checklistId: id }), [navigate]);

  function openCreate(): void {
    setFormError(null);
    setEditor('create');
  }
  // Ctrl+N : nouvelle checklist, comme pour les routines.
  const openCreateRef = useRef(openCreate);
  useEffect(() => {
    openCreateRef.current = openCreate;
  });
  useEffect(() => container.shortcuts.register('app.newTask', () => openCreateRef.current()), [container]);

  function closeEditor(): void {
    setEditor(null);
    setFormError(null);
  }

  async function save(input: NewChecklistInput): Promise<boolean> {
    if (editor === 'edit' && displayed) {
      const result = await update(displayed.checklist.id as ChecklistId, input);
      if (!result.ok) {
        setFormError(t('checklists.saveError'));
        return false;
      }
      closeEditor();
      return true;
    }
    const result = await create(input);
    if (!result.ok) {
      setFormError(t('checklists.saveError'));
      return false;
    }
    announceCreation(result.value.spaceId);
    setFocusRequest(result.value.id as ChecklistId);
    choose(result.value.id as ChecklistId);
    closeEditor();
    return true;
  }

  const filteredSpace = spaceFilter === 'all' ? null : spaces.find((space) => space.id === spaceFilter);
  const emptyMessage = projectFilter ? t('checklists.emptyProject') : filteredSpace ? t('checklists.emptySpace', { space: filteredSpace.name }) : t('checklists.empty');
  const pills = <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />;
  const itemsReady = itemsFor === displayedId;
  const detailItems = itemsReady ? items : [];
  // Les items affichés font foi (cochage immédiat) ; le temps du chargement, la progression vient de la liste.
  const progress = displayed && !itemsReady ? { checked: displayed.checked, total: displayed.total, ratio: displayed.total === 0 ? 0 : displayed.checked / displayed.total } : checklistProgress(detailItems);
  // Même règle pour « 3 / 6 » du volet : la checklist affichée suit ses items sans attendre la relecture.
  const listed = visible.map((summary) => (itemsReady && summary.checklist.id === displayedId ? { ...summary, checked: progress.checked, total: progress.total } : summary));

  const detail = displayed ? (
    <ChecklistDetail
      layout={layout}
      checklist={displayed.checklist}
      items={detailItems}
      progress={progress}
      compact={compact}
      onCompactChange={(value) => void setCompact(value)}
      onToggleItem={toggleItem}
      onRenameItem={async (id, text) => (await renameItem(id, text)).ok}
      focusRequest={focusRequest}
      onFocused={clearFocusRequest}
      onEdit={() => {
        setFormError(null);
        setEditor('edit');
      }}
      onAddItem={async (text) => (await addItem(text)).ok}
      onPlan={() => setDatePromptOpen(true)}
      onClearDate={() => void setDate(displayed.checklist.id as ChecklistId, null)}
      onDuplicate={() => void duplicateDisplayed()}
      spaceName={spaces.find((space) => space.id === displayed.checklist.spaceId)?.name ?? null}
    />
  ) : status === 'ready' || projectFilter ? (
    <div className="ct-checklists__empty">
      <p className="ct-checklists__emptyText">{emptyMessage}</p>
      {!projectFilter && layout === 'mobile' && <p className="ct-checklists__emptyHelp">{t('checklists.emptyHelp')}</p>}
    </div>
  ) : null;

  const errors = (
    <>
      {actionErrorKey && (
        <p className="ct-checklists__error" role="alert">
          {t(actionErrorKey)}
        </p>
      )}
      {status === 'error' && errorKey && (
        <p className="ct-checklists__error" role="alert">
          {t(errorKey)}
        </p>
      )}
    </>
  );

  const editorHost =
    editor && defaultSpaceId && (editor === 'create' || displayed) ? (
      <ChecklistEditorHost label={editor === 'edit' ? t('checklists.sheet.editTitle') : t('checklists.sheet.newTitle')} onClose={closeEditor}>
        <ChecklistForm
          key={editor === 'edit' ? displayedId : 'new'}
          checklist={editor === 'edit' ? (displayed?.checklist ?? null) : null}
          spaces={spaces}
          initialSpaceId={defaultSpaceId}
          onSubmit={save}
          onClose={closeEditor}
          errorMessage={formError}
          {...(editor === 'edit' && displayed
            ? {
                onDelete: () => setDeleteTarget(displayed.checklist.id as ChecklistId),
                extras: (
                  <>
                    <ChecklistDateRow date={displayed.checklist.date} onPick={() => setDatePromptOpen(true)} onClear={() => void setDate(displayed.checklist.id as ChecklistId, null)} />
                    <ChecklistTemplateRows
                      isTemplate={displayed.checklist.isTemplate}
                      onTemplateChange={(isTemplate) => void update(displayed.checklist.id as ChecklistId, { isTemplate })}
                      onDuplicate={() => void duplicateDisplayed()}
                    />
                  </>
                ),
              }
            : {})}
        />
      </ChecklistEditorHost>
    ) : null;

  const datePrompt = displayed ? (
    <DatePrompt
      open={datePromptOpen}
      label={t('checklists.date.pick')}
      confirmLabel={t('checklists.date.promptConfirm')}
      today={today}
      initialValue={displayed.checklist.date}
      onConfirm={(date) => {
        setDatePromptOpen(false);
        if (date) void setDate(displayed.checklist.id as ChecklistId, date);
      }}
      onClose={() => setDatePromptOpen(false)}
    />
  ) : null;

  const deleting = deleteTarget ? visible.find((summary) => summary.checklist.id === deleteTarget)?.checklist : undefined;
  const confirm = deleting ? (
    <ConfirmDialog
      title={t('checklists.sheet.deleteTitle', { title: deleting.title })}
      description={t('checklists.sheet.deleteBody')}
      confirmLabel={t('checklists.sheet.deleteConfirm')}
      onCancel={() => setDeleteTarget(null)}
      onConfirm={() => {
        const id = deleting.id as ChecklistId;
        setDeleteTarget(null);
        void remove(id).then((done) => {
          if (done) closeEditor();
        });
      }}
    />
  ) : null;

  if (layout === 'pc') {
    return (
      <div className="ct-checklists" data-layout="pc">
        <aside className="ct-checklists__pane" aria-label={t('checklists.listLabel')}>
          <h1 className="ct-checklists__paneTitle">{t('checklists.title')}</h1>
          {pills}
          <ChecklistList summaries={listed} selectedId={displayedId} spaces={spaces} showSpace={spaceFilter === 'all'} onSelect={choose} />
          <div className="ct-checklists__spacer" />
          <button type="button" className="ct-checklists__newButton" onClick={openCreate}>
            {t('checklists.addPc')}
          </button>
        </aside>
        <main className="ct-checklists__main">
          {errors}
          {detail}
        </main>
        {editorHost}
        {datePrompt}
        {confirm}
      </div>
    );
  }

  return (
    <div className="ct-checklists" data-layout="mobile">
      <div className="ct-checklists__topRow">
        {visible.length > 0 && displayedId ? (
          <DropdownSelect
            variant="pill"
            className="ct-checklists__chooser"
            label={t('checklists.chooserLabel')}
            options={visible.map(({ checklist }) => ({
              value: checklist.id,
              label: spaceFilter === 'all' ? `${checklist.title} · ${spaces.find((space) => space.id === checklist.spaceId)?.name ?? ''}` : checklist.title,
            }))}
            value={displayedId}
            display={displayed?.checklist.title ?? ''}
            onChange={(value) => choose(value as ChecklistId)}
          />
        ) : (
          <h1 className="ct-checklists__mobileTitle">{t('checklists.title')}</h1>
        )}
      </div>
      {pills}
      {errors}
      {detail}
      <div className="ct-checklists__bottomRow">
        <Fab onClick={openCreate} label={t('checklists.add')} />
      </div>
      {editorHost}
      {datePrompt}
      {confirm}
    </div>
  );
}
