import { useEffect, useState, useSyncExternalStore } from 'react';
import { appleFreshness, appleLinkState, hasAssociatedIphone } from '../../../domain/appleReminders';
import { utcToLocal } from '../../../domain/timeZone';
import type { IsoDateTime } from '../../../domain/types';
import { t } from '../../../i18n';
import { formatDayMonth, formatTime } from '../../../i18n/format';
import { detectTimeZone } from '../../../platform';
import { logFailure } from '../../../platform/desktop/log';
import { useAppContainer, useFeatureStore } from '../../app/AppContainerContext';
import { useAppStore } from '../../app/appStore';
import { syncStore } from '../../sync/syncStore';
import { useMinuteClock } from '../useMinuteClock';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';

/**
 * Texte « Mis à jour sur l'iPhone à 09:30 » / « hier à 09:30 » / « le 6 oct. à 09:30 » (K-07 critère 5) : la dernière lecture réussie que
 * l'iPhone a publiée (`appleReminders.lastPassAt`), à l'heure locale du PC (24 h) ; jamais l'instant brut.
 */
export function lastPassText(lastPassAt: IsoDateTime | null, nowMs: number, timeZone: string): string {
  if (lastPassAt === null) return t('appleReminders.pcNeverRead');
  try {
    const at = utcToLocal(lastPassAt, timeZone);
    const today = utcToLocal(new Date(nowMs).toISOString(), timeZone).date;
    const yesterday = utcToLocal(new Date(nowMs - 86_400_000).toISOString(), timeZone).date;
    const time = formatTime(at.time);
    if (at.date === today) return t('appleReminders.pcUpdatedToday', { time });
    if (at.date === yesterday) return t('appleReminders.pcUpdatedYesterday', { time });
    return t('appleReminders.pcUpdatedOn', { date: formatDayMonth(at.date), time });
  } catch {
    return t('appleReminders.pcNeverRead');
  }
}

/** Avertissement de fraîcheur (K-07 D1) : texte, ou null quand tout est à jour ou que rien n'est suivi. */
export function freshnessText(freshness: ReturnType<typeof appleFreshness>, lastPassAt: IsoDateTime | null, timeZone: string): string | null {
  switch (freshness) {
    case 'fresh':
      return null;
    case 'no-iphone':
      return t('appleReminders.pcNoIphone');
    case 'never':
      return t('appleReminders.pcNeverStale');
    case 'stale': {
      if (lastPassAt === null) return null;
      const at = utcToLocal(lastPassAt, timeZone);
      return t('appleReminders.pcStale', { date: formatDayMonth(at.date), time: formatTime(at.time) });
    }
  }
}

/**
 * Section « RAPPELS APPLE » sur le PC (K-05 critère 6, K-07 critères 5 et 7) : lecture seule. Les Rappels n'ont aucun accès direct sous
 * Windows : ils arrivent par la synchro d'iCloud Drive après un passage sur l'iPhone. L'écran montre ce que la synchro a apporté : listes
 * suivies (nom, espace), heure de la dernière lecture de l'iPhone, nombre de tâches liées, modifications en attente d'envoi, avertissement
 * de fraîcheur (plus de 24 h, aucun iPhone associé) ; ni connexion, ni choix de liste, ni réglage de création (« Se règle sur l'iPhone »).
 * Aucun appel de plugin, aucune notification.
 */
export function AppleRemindersReadOnly() {
  const container = useAppContainer();
  const lists = useFeatureStore(appleRemindersStore, (s) => s.lists);
  const lastPassAt = useFeatureStore(appleRemindersStore, (s) => s.lastPassAt);
  const pending = useFeatureStore(appleRemindersStore, (s) => s.pending);
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const spaces = useAppStore((s) => s.spaces);
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const nowMs = useMinuteClock(container.clock);
  const entities = useSyncExternalStore(container.taskEntities.subscribe, container.taskEntities.getSnapshot);
  const [linked, setLinked] = useState<number | null>(null);
  const [linkedFailed, setLinkedFailed] = useState(false);

  // Les réglages partagés reçus par la synchro depuis l'ouverture de l'app sont relus à l'ouverture de l'écran.
  useEffect(() => {
    void appleRemindersState(container).reload();
  }, [container]);

  useEffect(() => {
    let alive = true;
    container.data.repos.tasks.listAppleSourced().then(
      (tasks) => {
        if (!alive) return;
        setLinkedFailed(false);
        setLinked(tasks.filter((task) => appleLinkState(task) === 'linked').length);
      },
      () => {
        // Jamais un silence : le nombre est remplacé par un message.
        logFailure('apple-reminders', 'linked-count-failed');
        if (alive) {
          setLinked(null);
          setLinkedFailed(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [container, entities, lastPassAt]);

  const followed = lists.lists.filter((list) => list.shown);
  const used = followed.length > 0 || lastPassAt !== null || (linked ?? 0) > 0;
  const freshness = appleFreshness({ nowMs, lastPassAt, iphoneAssociated: hasAssociatedIphone(devices) });
  const warning = used ? freshnessText(freshness, lastPassAt, timeZone) : null;

  return (
    <section className="ct-calendars__apple" aria-label={t('appleReminders.section')}>
      <h2 className="ct-calendars__section">{t('appleReminders.section')}</h2>
      <p className="ct-calendars__appleText">{t('appleReminders.pcInfo')}</p>
      <h3 className="ct-calendars__caption">{t('appleReminders.pcListsCaption')}</h3>
      {followed.length === 0 && <p className="ct-calendars__empty">{t('appleReminders.pcNoLists')}</p>}
      <ul className="ct-calendars__list">
        {followed.map((list) => (
          <li key={list.id} className="ct-calendars__calendar">
            <span className="ct-calendars__name">{list.name}</span>
            <span className="ct-calendars__readOnly">{spaces.find((space) => space.id === list.spaceId)?.name ?? ''}</span>
          </li>
        ))}
      </ul>
      {used && <p className="ct-calendars__appleText">{lastPassText(lastPassAt, nowMs, timeZone)}</p>}
      {linked !== null && linked > 0 && <p className="ct-calendars__appleText">{t('appleReminders.pcLinkedCount', { count: linked })}</p>}
      {linkedFailed && (
        <p className="ct-calendars__error" role="status">
          {t('appleReminders.linkedCountUnreadable')}
        </p>
      )}
      {pending !== null && pending.count > 0 && <p className="ct-calendars__appleText">{t('appleReminders.pcPending', { count: pending.count })}</p>}
      {warning !== null && (
        <p className="ct-calendars__error" role="status">
          {warning}
        </p>
      )}
      <p className="ct-calendars__appleText">{t('appleReminders.pcSetOnIphone')}</p>
    </section>
  );
}
