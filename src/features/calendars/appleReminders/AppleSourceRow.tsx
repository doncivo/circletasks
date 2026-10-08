import { appleLinkState } from '../../../domain/appleReminders';
import type { Task } from '../../../domain/model';
import { t } from '../../../i18n';
import { useFeatureStore } from '../../app/AppContainerContext';
import { DetailRow } from '../../tasks/DetailRow';
import { appleRemindersStore } from './appleRemindersState';

/**
 * Ligne « Source : Rappels · liste {nom} » de la fiche d'une tâche liée à un rappel Apple (K-05 critère 13, A-08), en lecture seule, avec
 * « Récurrent dans Rappels » pour un rappel récurrent. Le nom de la liste vient du réglage partagé (donc lisible sur le PC, K-07) ; sans nom
 * connu : « Source : Rappels ». Une tâche détachée (liste décochée, rappel supprimé) dit « Détachée de Rappels » (K-07 critère 8).
 * Rien ne s'affiche pour une tâche ordinaire.
 */
export function AppleSourceRow({ task }: { readonly task: Pick<Task, 'source' | 'externalId' | 'appleListId' | 'appleRecurring'> }) {
  const lists = useFeatureStore(appleRemindersStore, (s) => s.lists);
  const state = appleLinkState(task);
  if (state === 'ordinary') return null;
  if (state === 'detached') return <DetailRow label={t('appleReminders.badge')}>{t('appleReminders.detachedLine')}</DetailRow>;
  const name = task.appleListId === null ? '' : (lists.lists.find((list) => list.id === task.appleListId)?.name ?? '');
  return (
    <DetailRow label={t('appleReminders.badge')}>
      {name === '' ? t('appleReminders.sourceLineNoList') : t('appleReminders.sourceLine', { name })}
      {task.appleRecurring && <span> · {t('appleReminders.badgeRecurring')}</span>}
    </DetailRow>
  );
}
