import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSigningAlert, createFakeSigningSource, type FakeSigningSource } from '../../platform/signing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useAppStatusStore } from '../app/appStatus';
import { RemindersStatusSection } from '../reminders/RemindersStatusSection';
import { replanNotifications } from '../reminders/replanNotifications';
import { setupReminders, type ReminderHarness } from '../reminders/testKit';
import { AboutSection } from './AboutSection';

/**
 * I-02 critères 7 et 8 : la ligne « Expire le … » de « À propos » (iPhone), l'état « date inconnue » dans « À propos » et dans Réglages >
 * Rappels, le texte « notifications refusées ». Maintenant : jeudi 8 octobre 2026, 10:00 à Paris.
 */
function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('À propos : expiration de la signature (I-02)', () => {
  let h: ReminderHarness;
  let source: FakeSigningSource;
  beforeEach(async () => {
    mockViewport(440);
    source = createFakeSigningSource();
    h = await setupReminders({ parts: { signing: { source, alert: createFakeSigningAlert() } } });
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStatusStore.setState({ sources: {} });
    await h.db.close();
  });

  const renderAbout = () =>
    render(
      <AppContainerProvider container={h.container}>
        <AppStatusBanner />
        <AboutSection />
        <RemindersStatusSection />
      </AppContainerProvider>,
    );

  it('expiration dans 6 jours : « Expire le … à 10:00 · dans 6 jours » et l’alerte prévue (24 h, heure murale)', async () => {
    source.expireAt('2026-10-14T08:00:00Z');
    await replanNotifications(h.container, 'open');
    renderAbout();
    expect(await screen.findByText('Expire le mer. 14 oct. à 10:00 · dans 6 jours')).toBeInTheDocument();
    expect(screen.getByText('Alerte prévue le mar. 13 oct. à 10:00')).toBeInTheDocument();
  });

  it('sous 48 h : « dans 30 h » ; sous 24 h : bandeau et « Moins de 24 h restantes »', async () => {
    source.expireAt('2026-10-09T14:00:00Z');
    await replanNotifications(h.container, 'open');
    const view = renderAbout();
    expect(await screen.findByText(/· dans 30 h$/)).toBeInTheDocument();
    view.unmount();
    source.expireAt('2026-10-08T20:00:00Z');
    await replanNotifications(h.container, 'resume');
    renderAbout();
    expect(await screen.findByText('Moins de 24 h restantes : actualisez CircleTasks dans SideStore')).toBeInTheDocument();
    expect(screen.getByText('CircleTasks expire dans 12 h : actualisez-la dans SideStore')).toBeInTheDocument();
  });

  it('signature expirée : dite en toutes lettres', async () => {
    source.expireAt('2026-10-08T07:00:00Z');
    await replanNotifications(h.container, 'open');
    renderAbout();
    expect(await screen.findByText(/^Signature expirée depuis le jeu\. 8 oct\. à 09:00$/)).toBeInTheDocument();
    expect(screen.getByText('La signature est expirée : réinstallez l’app')).toBeInTheDocument();
  });

  it('profil absent ou illisible : « Date d’expiration inconnue » dans À propos ET dans Réglages > Rappels, avec le code', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    source.fail('profile-missing');
    await replanNotifications(h.container, 'open');
    renderAbout();
    const lines = await screen.findAllByText(/Date d’expiration inconnue : l’alerte avant expiration est désactivée/);
    expect(lines).toHaveLength(2);
    expect(screen.getAllByText(/profil de signature absent/)).toHaveLength(2);
  });

  it('autorisation refusée : « Les notifications sont refusées : vous ne serez pas prévenu » à la place de l’alerte prévue', async () => {
    source.expireAt('2026-10-14T08:00:00Z');
    h.fake.setPermission('denied');
    await replanNotifications(h.container, 'open');
    renderAbout();
    expect(await screen.findByText('Les notifications sont refusées : vous ne serez pas prévenu')).toBeInTheDocument();
    expect(screen.queryByText(/Alerte prévue/)).toBeNull();
    expect(screen.getByText('Expire le mer. 14 oct. à 10:00 · dans 6 jours')).toBeInTheDocument();
  });

  it('alerte non planifiée : « L’alerte n’a pas pu être planifiée »', async () => {
    const alert = createFakeSigningAlert();
    alert.failSchedule = true;
    const failing = await setupReminders({ parts: { signing: { source, alert } } });
    source.expireAt('2026-10-14T08:00:00Z');
    await replanNotifications(failing.container, 'open');
    render(
      <AppContainerProvider container={failing.container}>
        <AboutSection />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('L’alerte n’a pas pu être planifiée : vous ne serez peut-être pas prévenu')).toBeInTheDocument();
    await failing.db.close();
  });

  it('mise à jour à la reprise : la date suit l’actualisation par SideStore', async () => {
    source.expireAt('2026-10-14T08:00:00Z');
    await replanNotifications(h.container, 'open');
    renderAbout();
    expect(await screen.findByText(/Expire le mer\. 14 oct\./)).toBeInTheDocument();
    source.expireAt('2026-10-15T09:12:34Z');
    await replanNotifications(h.container, 'resume');
    await waitFor(() => expect(screen.getByText(/Expire le jeu\. 15 oct\. à 11:12/)).toBeInTheDocument());
  });

  it('avant le premier passage : « Lecture de la date d’expiration… » (jamais une date inventée)', async () => {
    renderAbout();
    expect(await screen.findByText('Lecture de la date d’expiration…')).toBeInTheDocument();
  });

  it('PC et navigateur : aucune ligne', async () => {
    const pc = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
    render(
      <AppContainerProvider container={pc.container}>
        <AboutSection />
        <RemindersStatusSection />
      </AppContainerProvider>,
    );
    expect(screen.queryByText(/Expire le|Date d’expiration|Lecture de la date/)).toBeNull();
    await pc.db.close();
  });
});
