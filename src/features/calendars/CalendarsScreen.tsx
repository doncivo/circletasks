import { accountDisplayName } from './accountName';
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CalendarAccountState } from '../../domain/calendarRefresh';
import type { CalendarAccount, CalendarRef } from '../../domain/model';
import type { SpaceId } from '../../domain/types';
import { t, type PlainMessageKey } from '../../i18n';
import { Button, Checkbox, ConfirmDialog, DropdownSelect, Icon, spaceTextColor, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { calendarsStore, FAILURE_KEYS } from './calendarsStore';
import { IcloudForm } from './IcloudForm';
import { formatUpdated } from './updatedText';
import { useMinuteClock } from './useMinuteClock';
import './CalendarsScreen.css';

function stateLabelKey(state: CalendarAccountState | undefined): PlainMessageKey {
  if (!state || state.kind === 'connected') return 'calendars.stateConnected';
  if (state.kind === 'reconnect-required') return 'calendars.stateReconnect';
  return state.error === 'rate-limited' ? 'calendars.stateRateLimited' : 'calendars.stateOffline';
}

interface AccountCardProps {
  readonly account: CalendarAccount;
  readonly state: CalendarAccountState | undefined;
  readonly refreshing: boolean;
  readonly nowMs: number;
  readonly onRefresh: () => void;
  readonly onReconnect: () => void;
  readonly onRemove: () => void;
  readonly onChange: (calendars: readonly CalendarRef[]) => void;
}

function AccountCard({ account, state, refreshing, nowMs, onRefresh, onReconnect, onRemove, onChange }: AccountCardProps) {
  const spaces = useAppStore((s) => s.spaces);
  const providerName = t(account.provider === 'google' ? 'calendars.providerGoogle' : 'calendars.providerIcloud');
  const reconnect = state?.kind === 'reconnect-required';
  const spaceOptions = spaces.map((space) => ({ value: space.id, label: space.name }));
  const name = accountDisplayName(account);
  const update = (id: string, patch: Partial<CalendarRef>): void => onChange(account.calendars.map((calendar) => (calendar.id === id ? { ...calendar, ...patch } : calendar)));
  return (
    <section className="ct-calendars__card" aria-label={`${providerName} · ${name}`}>
      <div className="ct-calendars__cardHead">
        <div className="ct-calendars__identity">
          <span className="ct-calendars__provider">{providerName}</span>
          <span className="ct-calendars__label">{name}</span>
        </div>
        <span className="ct-calendars__state" data-state={state?.kind ?? 'connected'}>
          {t(stateLabelKey(state))}
        </span>
      </div>
      <span className="ct-calendars__updated">{formatUpdated(state?.lastSuccessAt ?? null, nowMs)}</span>
      <div className="ct-calendars__actions">
        {reconnect && (
          <Button ariaLabel={t('calendars.reconnectLabel', { label: name })} onClick={onReconnect}>
            {t('calendars.reconnect')}
          </Button>
        )}
        <Button variant="secondary" disabled={refreshing} ariaLabel={t('calendars.refreshLabel', { label: name })} onClick={onRefresh}>
          {refreshing ? t('calendars.refreshing') : t('calendars.refresh')}
        </Button>
        <Button variant="secondary" ariaLabel={t('calendars.removeLabel', { label: name })} onClick={onRemove}>
          {t('calendars.remove')}
        </Button>
      </div>
      <h3 className="ct-calendars__caption">{t('calendars.calendarsCaption')}</h3>
      {account.calendars.length === 0 && <p className="ct-calendars__empty">{t('calendars.calendarsEmpty')}</p>}
      <ul className="ct-calendars__list">
        {account.calendars.map((calendar) => {
          const space = spaces.find((candidate) => candidate.id === calendar.spaceId) ?? null;
          return (
            <li key={calendar.id} className="ct-calendars__calendar">
              <Checkbox checked={calendar.shown} label={t('calendars.showLabel', { name: calendar.name })} onChange={(shown) => update(calendar.id, shown ? { shown, spaceId: calendar.spaceId ?? spaces[0]?.id ?? null } : { shown })} />
              <span className="ct-calendars__dot" style={{ background: space ? spaceTextColor(space.color) : 'var(--ct-color-event-text)' }} aria-hidden="true" />
              <span className="ct-calendars__name">{calendar.name}</span>
              <DropdownSelect
                variant="pill"
                label={t('calendars.spaceLabel', { name: calendar.name })}
                options={spaceOptions}
                value={calendar.spaceId ?? ''}
                {...(space ? {} : { display: '…' })}
                onChange={(spaceId) => update(calendar.id, { spaceId: spaceId as SpaceId })}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Écran « Agendas » (K-01 à K-03, ouvert depuis Réglages › ESPACES ET CALENDRIERS) : comptes connectés, état, « Mis à jour il y a N min »,
 * « Actualiser », agendas affichés avec leur espace Pro / Perso (ES-06, enregistrés aussitôt), connexion Google (navigateur) ou iCloud
 * (identifiant Apple et mot de passe d'application), suppression d'un compte. Non dessiné dans les maquettes : mêmes codes que Réglages
 * et « Espaces et projets » (décision D5 de K-01).
 */
export function CalendarsScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const load = useFeatureStore(calendarsStore, (s) => s.load);
  const accounts = useFeatureStore(calendarsStore, (s) => s.accounts);
  const states = useFeatureStore(calendarsStore, (s) => s.states);
  const refreshing = useFeatureStore(calendarsStore, (s) => s.refreshing);
  const connecting = useFeatureStore(calendarsStore, (s) => s.connecting);
  const errorKey = useFeatureStore(calendarsStore, (s) => s.errorKey);
  const messageKey = useFeatureStore(calendarsStore, (s) => s.messageKey);
  const icloudForm = useFeatureStore(calendarsStore, (s) => s.icloudForm);
  const store = calendarsStore.get(container);
  const nowMs = useMinuteClock(container.clock);
  const [removing, setRemoving] = useState<CalendarAccount | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ct-calendars-shell" data-layout={layout}>
      <div className="ct-calendars">
        <div className="ct-calendars__topRow">
          <button type="button" className="ct-calendars__back" aria-label={t('calendars.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-calendars__title">{t('calendars.title')}</h1>
        <div className="ct-calendars__rule" aria-hidden="true">
          <div className="ct-calendars__ruleAccent" />
          <div className="ct-calendars__ruleLine" />
        </div>
        {(errorKey ?? messageKey) !== null && (
          <p className="ct-calendars__error" role="alert">
            {t((errorKey ?? messageKey) as NonNullable<typeof errorKey>)}
          </p>
        )}
        <h2 className="ct-calendars__section">{t('calendars.sectionAccounts')}</h2>
        {accounts.length === 0 && <p className="ct-calendars__empty">{t('calendars.noAccount')}</p>}
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            state={states[account.id]}
            refreshing={refreshing.includes(account.id)}
            nowMs={nowMs}
            onRefresh={() => void store.getState().refresh(account.id, 'manual')}
            onReconnect={() => store.getState().requestReconnect(account.id)}
            onRemove={() => setRemoving(account)}
            onChange={(calendars) => void store.getState().setCalendars(account.id, calendars)}
          />
        ))}
        <h2 className="ct-calendars__section">{t('calendars.addGroup')}</h2>
        {connecting && (
          <p className="ct-calendars__connecting" role="status">
            {t('calendars.connecting')} {t('calendars.connectingHint')}
          </p>
        )}
        <div className="ct-calendars__add" role="group" aria-label={t('calendars.add')}>
          <Button
            variant="secondary"
            disabled={connecting}
            onClick={() => void store.getState().connectGoogle()}
          >
            {t('calendars.addGoogle')}
          </Button>
          <Button
            variant="secondary"
            disabled={connecting}
            onClick={() => store.getState().openIcloudForm()}
          >
            {t('calendars.addIcloud')}
          </Button>
        </div>
        {icloudForm && (
          <IcloudForm
            key={icloudForm.accountId ?? 'new'}
            initialUsername={icloudForm.username}
            usernameLocked={icloudForm.accountId !== null && icloudForm.username !== ''}
            onCancel={() => store.getState().closeIcloudForm()}
            onSubmit={async (username, password) => {
              const outcome = icloudForm.accountId === null ? await store.getState().connectIcloud(username, password) : await store.getState().reconnectIcloud(icloudForm.accountId, password, username);
              return outcome.ok ? null : FAILURE_KEYS[outcome.failure];
            }}
          />
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={t('calendars.removeTitle')}
          description={t('calendars.removeBody', { label: accountDisplayName(removing) })}
          confirmLabel={t('calendars.removeConfirm')}
          cancelLabel={t('calendars.removeCancel')}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void store.getState().removeAccount(target.id);
          }}
        />
      )}
    </div>
  );
}
