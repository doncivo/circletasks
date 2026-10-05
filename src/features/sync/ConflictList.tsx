import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { conflictDate, conflictSideMeta, conflictTitle, conflictValueText, fieldLabel, refusalText, restoreResultText, restoredOnText } from './conflictText';
import { createSyncConflictUseCases, subscribeConflictChanges, type ConflictPage, type ConflictView, type RestoreResult } from './syncConflictUseCases';
import { syncStore } from './syncStore';
import './ConflictList.css';

/** Sépare un texte traduit autour de sa valeur (« {value} gardée ») pour mettre la valeur en gras, dans l'ordre de la langue. */
function aroundValue(text: (value: string) => string): readonly [string, string] {
  const marker = '\u0000';
  const [before = '', after = ''] = text(marker).split(marker);
  return [before, after];
}

interface RowMessage {
  readonly text: string;
  /** Vrai : refus ou échec (couleur d'alerte), sans boîte bloquante. */
  readonly trouble: boolean;
}

/**
 * Bloc « JOURNAL DES CONFLITS » sous la ligne « N conflits cette semaine » de Y-02, qui porte le titre de section (Y-04 critères 1 à 4 et 14 ; Synchro.html) : une ligne par conflit, du plus récent au plus ancien, 50 par
 * page ; valeur gardée et valeur écartée, appareil et heure de chacune, « Restaurer » ou « Restaurée le <date> ». Absent sans conflit.
 * Résultat annoncé dans la ligne (`role="status"`), le focus reste sur la ligne (ou sur « Restaurer » si rien n'a changé) ; un refus
 * certain (élément ou parent disparu, valeur invalide) est **recalculé à chaque lecture** et affiché tant que l'état est bloqué ; un
 * échec de la base reste affiché jusqu'à la prochaine action ; « Annuler » retire le message de succès ; une lecture impossible ou des
 * lignes illisibles sont dites (exigence d'Ali : aucun échec silencieux).
 */
export function ConflictList() {
  const container = useAppContainer();
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const lastSyncAt = useFeatureStore(syncStore, (s) => s.status.lastSyncAt);
  const conflictsThisWeek = useFeatureStore(syncStore, (s) => s.status.conflictsThisWeek);
  const useCases = useMemo(() => createSyncConflictUseCases(container), [container]);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState<ConflictPage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [messages, setMessages] = useState<ReadonlyMap<number, RowMessage>>(new Map());
  const [busy, setBusy] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const focusAfter = useRef<number | null>(null);

  useEffect(
    () =>
      subscribeConflictChanges(container.data, (change) => {
        // Restauration annulée : le message de succès de la ligne n'est plus vrai.
        if (change.kind === 'undone') {
          setMessages((current) => {
            const next = new Map(current);
            next.delete(change.conflictId);
            return next;
          });
        }
        setVersion((v) => v + 1);
      }),
    [container],
  );

  useEffect(() => {
    let alive = true;
    useCases.list(pages).then(
      (next) => {
        if (!alive) return;
        setPage(next);
        setLoadFailed(false);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [useCases, pages, version, lastSyncAt, conflictsThisWeek]);

  // Après « Restaurer », le focus reste sur la ligne (critère 14) : sur la ligne si le bouton a disparu (« Restaurée le … »), sinon sur
  // le bouton, désactivé le temps de l'action. Appliqué à la relecture qui suit l'action (avis de changement).
  useEffect(() => {
    if (focusAfter.current === null) return;
    const row = rows.current.get(focusAfter.current);
    const button = row?.querySelector('button');
    if (row && !row.contains(document.activeElement)) (button ?? row).focus();
    focusAfter.current = null;
  }, [page]);

  if (loadFailed) {
    return (
      <p className="ct-settings__error" role="status">
        {t('sync.conflicts.loadFailed')}
      </p>
    );
  }
  if (!page || (page.items.length === 0 && page.unreadable === 0)) return null;

  const nowMs = container.clock.nowMs();

  const restore = async (view: ConflictView, names: { title: string; field: string }): Promise<void> => {
    if (busy !== null) return;
    setBusy(view.id);
    let result: RestoreResult;
    try {
      result = await useCases.restore(view.id);
    } finally {
      setBusy(null);
    }
    focusAfter.current = view.id;
    // Un refus n'est pas gardé : la relecture qui suit (avis de changement) recalcule le blocage, seul affiché.
    setMessages((current) => {
      const next = new Map(current);
      if (result.status === 'refused') next.delete(view.id);
      else next.set(view.id, { text: restoreResultText(result, names), trouble: result.status === 'failed' });
      return next;
    });
  };

  return (
    <>
      {page.unreadable > 0 && (
        <p className="ct-settings__error" role="status">
          {page.unreadable === 1 ? t('sync.conflicts.unreadableOne') : t('sync.conflicts.unreadableMany', { count: page.unreadable })}
        </p>
      )}
      <ul className="ct-conflicts" aria-label={t('sync.conflicts.listLabel')}>
        {page.items.map((view) => {
          const title = conflictTitle(view);
          const field = fieldLabel(view.table, view.column);
          const names = { title, field };
          const [keptBefore, keptAfter] = aroundValue((value) => t('sync.conflicts.kept', { value }));
          const [discardedBefore, discardedAfter] = aroundValue((value) => t('sync.conflicts.discarded', { value }));
          // Blocage recalculé à la lecture : il prime sur tout message gardé (critère 8, exigence d'Ali).
          const message = !view.restored && view.blocked ? { text: refusalText(view.blocked), trouble: true } : (messages.get(view.id) ?? null);
          const statusId = `ct-conflict-status-${String(view.id)}`;
          return (
            <li
              key={view.id}
              ref={(node) => {
                if (node) rows.current.set(view.id, node);
                else rows.current.delete(view.id);
              }}
              className="ct-conflicts__item"
              aria-label={t('sync.conflicts.itemLabel', names)}
              tabIndex={-1}
              data-restored={view.restored ? 'true' : undefined}
            >
              <div className="ct-conflicts__head">
                <span className="ct-conflicts__title">{t('sync.conflicts.heading', names)}</span>
                <span className="ct-conflicts__date">{conflictDate(view.detectedAt)}</span>
              </div>
              <div className="ct-conflicts__value ct-conflicts__value--kept">
                <span>
                  {keptBefore}
                  <b>{conflictValueText(view.table, view.column, view.kept, nowMs)}</b>
                  {keptAfter}
                </span>
                <span className="ct-conflicts__meta ct-conflicts__meta--kept">{conflictSideMeta(view.kept, devices, nowMs)}</span>
              </div>
              <div className="ct-conflicts__value ct-conflicts__value--discarded">
                <span>
                  {discardedBefore}
                  <b>{conflictValueText(view.table, view.column, view.discarded, nowMs)}</b>
                  {discardedAfter}
                </span>
                <span className="ct-conflicts__actions">
                  <span className="ct-conflicts__meta">{conflictSideMeta(view.discarded, devices, nowMs)}</span>
                  {view.restored ? (
                    <span className="ct-conflicts__restored">{view.restoredAt ? restoredOnText(view.restoredAt) : null}</span>
                  ) : (
                    <button
                      type="button"
                      className="ct-button ct-button--secondary ct-settings__link"
                      aria-label={t('sync.conflicts.restoreLabel', names)}
                      aria-describedby={message ? statusId : undefined}
                      aria-busy={busy === view.id}
                      disabled={busy !== null}
                      onClick={() => void restore(view, names)}
                    >
                      {busy === view.id ? t('sync.conflicts.restoring') : t('sync.conflicts.restore')}
                    </button>
                  )}
                </span>
              </div>
              <p id={statusId} className="ct-conflicts__status" role="status" data-trouble={message?.trouble ? 'true' : undefined}>
                {message?.text ?? ''}
              </p>
            </li>
          );
        })}
      </ul>
      {page.hasMore && (
        <Button variant="secondary" className="ct-settings__link ct-conflicts__more" onClick={() => setPages((n) => n + 1)}>
          {t('sync.conflicts.showMore')}
        </Button>
      )}
    </>
  );
}
