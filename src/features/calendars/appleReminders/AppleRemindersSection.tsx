import { useEffect } from 'react';
import { utcToLocal } from '../../../domain/timeZone';
import type { AppleNotice, ReminderList } from '../../../domain/appleReminders';
import type { SpaceId } from '../../../domain/types';
import { t } from '../../../i18n';
import { formatTime } from '../../../i18n/format';
import { detectTimeZone } from '../../../platform';
import { Button, Checkbox, DropdownSelect, Switch } from '../../../ui';
import { useAppContainer, useFeatureStore } from '../../app/AppContainerContext';
import { useAppStore } from '../../app/appStore';
import { appleRemindersActions } from './appleRemindersActions';
import { AppleRemindersReadOnly } from './AppleRemindersReadOnly';
import { appleRemindersStore, isWriteFailure } from './appleRemindersState';

/** Heure locale « 09:30 » (format de l'appareil) d'un instant ISO ; l'instant brut n'est jamais affiché. */
export function instantTime(iso: string, timeZone: string): string {
  try {
    return formatTime(utcToLocal(iso, timeZone).time);
  } catch {
    return '';
  }
}

/** Texte d'un message (jamais un titre : un nombre). */
export function noticeText(notice: AppleNotice): string {
  const count = notice.count;
  switch (notice.kind) {
    case 'deleted':
      return t('appleReminders.noticeDeleted', { count });
    case 'detached':
      return t('appleReminders.noticeDetached', { count });
    case 'detached-recurring':
      return t('appleReminders.noticeDetachedRecurring', { count });
    case 'unlinked-list':
      return t('appleReminders.noticeUnlinkedList', { count });
    case 'creation-off':
      return t('appleReminders.noticeCreationOff');
    case 'read-only-list':
      return t('appleReminders.noticeReadOnlyList', { count });
    case 'recurring-refused':
      return t('appleReminders.noticeRecurringRefused', { count });
    case 'duplicate-created':
      return t('appleReminders.noticeDuplicateCreated', { count });
  }
}

function messageText(message: 'space-required' | 'save-failed' | 'no-list' | 'list-not-in-space'): string {
  switch (message) {
    case 'space-required':
      return t('appleReminders.spaceRequired');
    case 'no-list':
      return t('appleReminders.createNoList');
    case 'list-not-in-space':
      return t('appleReminders.createListNotInSpace');
    case 'save-failed':
      return t('appleReminders.saveFailed');
  }
}

/**
 * Section « RAPPELS APPLE » de l'écran Agendas (K-05 critères 6 à 8, 12 à 14 ; ADR 0008 §10) : sur l'iPhone, l'accès (explication puis
 * « Autoriser l'accès aux Rappels », jamais au démarrage), les listes de Rappels avec « Afficher » et l'espace (prérempli Pro, une liste
 * affichée sans espace est refusée), « Actualiser », l'heure de dernière lecture, l'échec persistant, le plafond « 500 rappels sur 740
 * importés », les listes introuvables, les suppressions retenues par la garde et les messages. Sur le PC : lecture seule (K-07, composant
 * `AppleRemindersReadOnly`). Composée avec les composants de l'écran, comme « Silence Pro » (decisions.md, 2026-10-07).
 */
export function AppleRemindersSection() {
  const container = useAppContainer();
  const loaded = useFeatureStore(appleRemindersStore, (s) => s.loaded);
  const available = useFeatureStore(appleRemindersStore, (s) => s.available);
  const access = useFeatureStore(appleRemindersStore, (s) => s.access);
  const platformLists = useFeatureStore(appleRemindersStore, (s) => s.platformLists);
  const lists = useFeatureStore(appleRemindersStore, (s) => s.lists);
  const create = useFeatureStore(appleRemindersStore, (s) => s.create);
  const lastPassAt = useFeatureStore(appleRemindersStore, (s) => s.lastPassAt);
  const status = useFeatureStore(appleRemindersStore, (s) => s.status);
  const running = useFeatureStore(appleRemindersStore, (s) => s.running);
  const persistFailed = useFeatureStore(appleRemindersStore, (s) => s.persistFailed);
  const message = useFeatureStore(appleRemindersStore, (s) => s.message);
  const spaces = useAppStore((s) => s.spaces);
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const actions = appleRemindersActions(container);

  // Réglages lus, puis accès relu : à l'ouverture de l'écran et à la reprise de l'app, l'état d'accès refusé se rétablit tout seul.
  useEffect(() => {
    void actions.refreshAccess();
  }, [actions]);

  if (!loaded) return null;
  // PC : lecture seule, ce que la synchro a apporté (K-05 critère 6, K-07).
  if (!available) return <AppleRemindersReadOnly />;

  const spaceOptions = spaces.map((space) => ({ value: space.id, label: space.name }));
  const settingOf = (list: ReminderList) => lists.lists.find((entry) => entry.id === list.id);
  const nameOf = (listId: string): string => lists.lists.find((entry) => entry.id === listId)?.name ?? platformLists.find((entry) => entry.id === listId)?.name ?? '';
  const writeIssue = isWriteFailure(status.failure);

  return (
    <section className="ct-calendars__apple" aria-label={t('appleReminders.section')}>
      <h2 className="ct-calendars__section">{t('appleReminders.section')}</h2>

      {access === 'not-determined' && (
        <div className="ct-calendars__appleBlock">
          <p className="ct-calendars__appleText">{t('appleReminders.intro')}</p>
          <Button onClick={() => void actions.requestAccess()}>{t('appleReminders.allow')}</Button>
        </div>
      )}
      {access === 'denied' && (
        <p className="ct-calendars__error" role="status">
          {t('appleReminders.denied')}
        </p>
      )}
      {access === 'restricted' && (
        <p className="ct-calendars__error" role="status">
          {t('appleReminders.restricted')}
        </p>
      )}

      {status.failure !== null && access !== 'denied' && access !== 'restricted' && (
        <p className="ct-calendars__error" role="alert">
          {status.failure.code === 'access-denied' ? t('appleReminders.failureAccess') : writeIssue ? t('appleReminders.failureWrite', { code: status.failure.code }) : t('appleReminders.failure', { code: status.failure.code })}
        </p>
      )}
      {persistFailed && (
        <p className="ct-calendars__error" role="alert">
          {t('appleReminders.persistFailed')}
        </p>
      )}
      {message !== null && (
        <p className="ct-calendars__error" role="alert">
          {messageText(message)}
        </p>
      )}

      {access === 'full' && (
        <>
          <h3 className="ct-calendars__caption">{t('appleReminders.listsCaption')}</h3>
          {platformLists.length === 0 && <p className="ct-calendars__empty">{t('appleReminders.noLists')}</p>}
          <ul className="ct-calendars__list">
            {platformLists.map((list) => {
              const setting = settingOf(list);
              const space = spaces.find((candidate) => candidate.id === setting?.spaceId);
              return (
                <li key={list.id} className="ct-calendars__calendar">
                  <Checkbox checked={setting?.shown ?? false} label={t('appleReminders.showLabel', { name: list.name })} onChange={(shown) => void actions.setShown(list, shown)} />
                  <span className="ct-calendars__name">
                    {list.name}
                    {!list.writable && <span className="ct-calendars__readOnly"> · {t('appleReminders.readOnlyList')}</span>}
                  </span>
                  <DropdownSelect
                    variant="pill"
                    label={t('appleReminders.spaceLabel', { name: list.name })}
                    options={spaceOptions}
                    value={setting?.spaceId ?? ''}
                    {...(space ? {} : { display: '…' })}
                    onChange={(spaceId) => void actions.setSpace(list, spaceId as SpaceId)}
                  />
                </li>
              );
            })}
          </ul>

          <div className="ct-calendars__actions">
            <Button variant="secondary" disabled={running} onClick={() => void actions.refresh()}>
              {running ? t('appleReminders.refreshing') : t('appleReminders.refresh')}
            </Button>
            <span className="ct-calendars__updated">{lastPassAt === null ? t('appleReminders.neverRead') : t('appleReminders.updatedAt', { time: instantTime(lastPassAt, timeZone) })}</span>
          </div>

          <h3 className="ct-calendars__caption">{t('appleReminders.createCaption')}</h3>
          <p className="ct-calendars__appleText">{t('appleReminders.createHint')}</p>
          {spaces.map((space) => {
            const rule = create.bySpace.find((entry) => entry.spaceId === space.id);
            const destinations = lists.lists.filter((list) => list.shown && list.spaceId === space.id);
            return (
              <div key={space.id} className="ct-calendars__calendar">
                <Switch checked={rule?.enabled ?? false} label={t('appleReminders.createSwitch', { space: space.name })} onChange={(enabled) => void actions.setCreateRule(space.id, enabled, rule?.listId ?? destinations[0]?.id ?? null)} />
                <span className="ct-calendars__name">{space.name}</span>
                <DropdownSelect
                  variant="pill"
                  label={t('appleReminders.createList', { space: space.name })}
                  options={destinations.map((list) => ({ value: list.id, label: list.name }))}
                  value={rule?.listId ?? ''}
                  display={destinations.find((list) => list.id === rule?.listId)?.name ?? t('appleReminders.createChoose')}
                  onChange={(listId) => void actions.setCreateRule(space.id, rule?.enabled ?? false, listId)}
                />
              </div>
            );
          })}

          {status.caps.map((cap) => (
            <p key={cap.listId} className="ct-calendars__appleText" role="status">
              {t('appleReminders.cap', { imported: cap.imported, total: cap.total })} · {nameOf(cap.listId)}
            </p>
          ))}
          {status.missingLists.map((listId) => (
            <p key={listId} className="ct-calendars__error" role="status">
              {t('appleReminders.listMissing', { name: nameOf(listId) })}
            </p>
          ))}
          {status.unknown > 0 && (
            <p className="ct-calendars__appleText" role="status">
              {t('appleReminders.unknownLinks', { count: status.unknown })}
            </p>
          )}
          {status.held.map((held) => (
            <div key={`${held.listId}:${held.send === true ? 'send' : 'absent'}`} className="ct-calendars__appleBlock" role="group" aria-label={nameOf(held.listId)}>
              <p className="ct-calendars__error" role="alert">
                {t(held.send === true ? 'appleReminders.heldSendMessage' : 'appleReminders.heldMessage', { count: held.count })} · {nameOf(held.listId)}
              </p>
              <div className="ct-calendars__actions">
                <Button variant="secondary" onClick={() => void actions.resolveHeld(held.listId, 'delete', held.send === true)}>
                  {t(held.send === true ? 'appleReminders.heldSendDelete' : 'appleReminders.heldDelete')}
                </Button>
                <Button variant="secondary" onClick={() => void actions.resolveHeld(held.listId, 'keep', held.send === true)}>
                  {t(held.send === true ? 'appleReminders.heldSendKeep' : 'appleReminders.heldKeep')}
                </Button>
              </div>
            </div>
          ))}
        </>
      )}

      {status.notices.map((notice) => (
        <div key={notice.kind} className="ct-calendars__appleBlock" role="status">
          <p className="ct-calendars__appleText">{noticeText(notice)}</p>
          <Button variant="secondary" ariaLabel={t('appleReminders.noticeDismissLabel')} onClick={() => void actions.dismissNotice(notice.kind)}>
            {t('appleReminders.noticeDismiss')}
          </Button>
        </div>
      ))}
    </section>
  );
}
