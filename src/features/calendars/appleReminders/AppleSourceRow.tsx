import { useEffect, useState } from 'react';
import { appleLinkState, awaitsIphonePass } from '../../../domain/appleReminders';
import type { Task } from '../../../domain/model';
import { utcToLocal } from '../../../domain/timeZone';
import { t } from '../../../i18n';
import { formatDayMonth } from '../../../i18n/format';
import { detectTimeZone } from '../../../platform';
import { useAppContainer, useFeatureStore } from '../../app/AppContainerContext';
import { useAppStore } from '../../app/appStore';
import { DetailRow } from '../../tasks/DetailRow';
import { appleRemindersStore } from './appleRemindersState';

type Facts = Pick<Task, 'id' | 'source' | 'externalId' | 'appleListId' | 'appleRecurring' | 'hlc'>;

/** Instants (ms) des horloges de champ de la tâche : titre, échéance, heure, statut (modifications à envoyer) et détachement. */
interface Clocks {
  readonly taskId: string;
  readonly hlc: string;
  readonly send: readonly number[];
  readonly detachedAt: number | null;
}

/**
 * Lignes de la fiche d'une tâche d'origine Rappels Apple (K-05 critère 13, K-07 critères 2 et 8, A-08), en lecture seule :
 * - tâche liée : « Source : Rappels · liste {nom} » (nom lu dans le réglage partagé : lisible sur le PC) et « Récurrent dans Rappels » ;
 * - sur le PC, « Sera envoyée vers Rappels au prochain passage de l'iPhone » tant qu'un titre, une échéance ou un statut modifié ici est plus
 *   récent que la dernière lecture publiée par l'iPhone (état déduit des horloges de champ, K-07 D2) ; la mention disparaît dès que l'iPhone
 *   a envoyé (il republie alors sa dernière lecture) ;
 * - tâche détachée (liste décochée, rappel supprimé, rappel disparu) : « Détachée de Rappels le {date} » (la date est celle du détachement).
 * Rien ne s'affiche pour une tâche ordinaire.
 */
export function AppleSourceRow({ task }: { readonly task: Facts }) {
  const container = useAppContainer();
  const lists = useFeatureStore(appleRemindersStore, (s) => s.lists);
  const lastPassAt = useFeatureStore(appleRemindersStore, (s) => s.lastPassAt);
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const state = appleLinkState(task);
  const [clocks, setClocks] = useState<Clocks | null>(null);

  useEffect(() => {
    if (state !== 'linked' && state !== 'detached') return undefined;
    let alive = true;
    container.data.repos.appleLinks.fieldClocks([task.id]).then(
      (found) => {
        const fields = found.get(task.id);
        if (!alive || !fields) return;
        const ms = (hlc: string): number => Number(hlc.slice(0, 15));
        setClocks({ taskId: task.id, hlc: task.hlc, send: [fields.title, fields.date, fields.time, fields.status].map(ms), detachedAt: ms(fields.external_id) });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [container, state, task.id, task.hlc]);

  if (state === 'ordinary' || state === 'to-create') return state === 'to-create' ? <DetailRow label={t('appleReminders.badge')}>{t('appleReminders.willBeSent')}</DetailRow> : null;
  const ready = clocks !== null && clocks.taskId === task.id && clocks.hlc === task.hlc ? clocks : null;
  if (state === 'detached') {
    let when: string | null = null;
    if (ready?.detachedAt) {
      try {
        when = formatDayMonth(utcToLocal(new Date(ready.detachedAt).toISOString(), timeZone).date);
      } catch {
        when = null;
      }
    }
    return <DetailRow label={t('appleReminders.badge')}>{when === null ? t('appleReminders.detachedLine') : t('appleReminders.detachedLineOn', { date: when })}</DetailRow>;
  }
  const name = task.appleListId === null ? '' : (lists.lists.find((list) => list.id === task.appleListId)?.name ?? '');
  const waiting = !container.reminders.available && ready !== null && awaitsIphonePass(ready.send, lastPassAt);
  return (
    <>
      <DetailRow label={t('appleReminders.badge')}>
        {name === '' ? t('appleReminders.sourceLineNoList') : t('appleReminders.sourceLine', { name })}
        {task.appleRecurring && <span> · {t('appleReminders.badgeRecurring')}</span>}
      </DetailRow>
      {waiting && <p className="ct-task-detail__stamp">{t('appleReminders.willBeSent')}</p>}
    </>
  );
}
