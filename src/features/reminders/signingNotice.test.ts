import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { parseSigningStatus } from '../../domain/signingNotice';
import { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from '../../platform/signing';
import { createTauriSigningAlert } from '../../platform/signing/tauriSigningAlert';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { replanNotifications } from './replanNotifications';
import { SIGNING_TRIGGERS } from './signingNotice';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * I-02 critères 4 à 7 et 10 (ADR 0013 §3.4) : l'étape d'alerte du passage de replanification, avec faux profil et faux planificateur.
 * Maintenant : 2026-10-08 08:00 UTC = 10:00 à Paris.
 */
const NOW = Date.parse('2026-10-08T08:00:00.000Z');
const IN_6_DAYS = '2026-10-14T08:00:00Z';
const IN_6_DAYS_ALERT = Date.parse('2026-10-13T08:00:00Z');
const IN_7_DAYS = '2026-10-15T09:12:34Z';

const banner = () => useAppStatusStore.getState().sources.signingExpiry;
const troubles = () => useAppStatusStore.getState().sources.remindersTrouble;

interface Rig {
  readonly h: ReminderHarness;
  readonly source: FakeSigningSource;
  readonly alert: FakeSigningAlert;
}

async function rig(mode: 'fake' | 'real' = 'fake'): Promise<Rig> {
  const source = createFakeSigningSource();
  const alert = createFakeSigningAlert();
  const h = await setupReminders({ mode, parts: { signing: { source, alert } } });
  return { h, source, alert };
}

const storedSigning = async (container: AppContainer) => parseSigningStatus(await container.data.repos.settings.get('notifications.signing'));

describe('I-02 : planification de l’alerte (critères 4 et 5)', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.h.db.close());

  it('expiration dans 6 jours : une demande à expiresAt − 24 h, texte neutre de D1 en heure murale 24 h', async () => {
    r.source.expireAt(IN_6_DAYS, '2026-10-07T08:00:00Z');
    await replanNotifications(r.h.container, 'open');
    expect(r.alert.scheduled).toHaveLength(1);
    const request = r.alert.scheduled[0];
    expect(request).toMatchObject({ instant: IN_6_DAYS_ALERT, zone: 'Europe/Paris', title: 'CircleTasks va expirer' });
    expect(request?.body).toBe('Vérifiez dans SideStore que l’app a été actualisée (expiration prévue le mer. 14 oct. à 10:00)');
    expect(banner()).toBeUndefined();
    const saved = await storedSigning(r.h.container);
    expect(saved.unreadable).toBe(false);
    expect(saved.status.scheduled).toEqual({ instant: IN_6_DAYS_ALERT, expiresAt: IN_6_DAYS });
    expect(saved.status.lastRead).toMatchObject({ expiresAt: IN_6_DAYS, issuedAt: '2026-10-07T08:00:00Z', at: new Date(NOW).toISOString() });
    expect(saved.status.failure).toBeNull();
  });

  it('un second passage identique ne la renvoie pas ; une autre expiration (actualisation) la remplace, même identifiant', async () => {
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    await replanNotifications(r.h.container, 'resume');
    expect(r.alert.scheduled).toHaveLength(1);
    expect(r.source.reads).toBe(2);
    // SideStore a actualisé l'app : nouvelle échéance, nouvel instant.
    r.source.expireAt(IN_7_DAYS);
    await replanNotifications(r.h.container, 'resume');
    expect(r.alert.scheduled).toHaveLength(2);
    expect(r.alert.scheduled[1]?.instant).toBe(Date.parse(IN_7_DAYS) - 24 * 3_600_000);
    expect(r.alert.pending?.instant).toBe(r.alert.scheduled[1]?.instant);
    expect((await storedSigning(r.h.container)).status.scheduled?.expiresAt).toBe(IN_7_DAYS);
  });

  it('une alerte disparue de la liste en attente est renvoyée au passage suivant', async () => {
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    r.alert.pending = null;
    await replanNotifications(r.h.container, 'resume');
    expect(r.alert.scheduled).toHaveLength(2);
  });

  it('premier passage d’un nouveau processus : renvoyée (la table du plugin est en mémoire)', async () => {
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    const reopened = reopenReminders(r.h, { parts: { signing: { source: r.source, alert: r.alert } } });
    await replanNotifications(reopened, 'open');
    expect(r.alert.scheduled).toHaveLength(2);
    await replanNotifications(reopened, 'resume');
    expect(r.alert.scheduled).toHaveLength(2);
  });

  it('open, resume et permission relisent la date ; edit, sync, hide, zone et action ne la lisent pas', async () => {
    expect(SIGNING_TRIGGERS).toEqual(['open', 'resume', 'permission']);
    r.source.expireAt(IN_6_DAYS);
    for (const trigger of ['open', 'resume', 'permission'] as const) await replanNotifications(r.h.container, trigger);
    expect(r.source.reads).toBe(3);
    for (const trigger of ['edit', 'sync', 'hide', 'zone', 'action'] as const) await replanNotifications(r.h.container, trigger);
    expect(r.source.reads).toBe(3);
  });

  it('le texte de l’alerte ne contient ni titre de tâche ni donnée personnelle (critère 10)', async () => {
    await seedReminderTask(r.h.container, { title: 'Dossier médical confidentiel', date: '2026-10-09', time: '09:00' });
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    const request = r.alert.scheduled[0];
    expect(`${request?.title ?? ''} ${request?.body ?? ''}`).not.toMatch(/Dossier|médical|confidentiel/);
  });

  it('autorisation refusée ou non décidée : aucune planification, la date lue reste enregistrée', async () => {
    r.source.expireAt(IN_6_DAYS);
    for (const permission of ['denied', 'undetermined'] as const) {
      r.h.fake.setPermission(permission);
      await replanNotifications(r.h.container, 'open');
    }
    expect(r.alert.scheduled).toHaveLength(0);
    expect((await storedSigning(r.h.container)).status.lastRead?.expiresAt).toBe(IN_6_DAYS);
    // L'autorisation accordée (déclencheur `permission`) planifie l'alerte.
    r.h.fake.setPermission('granted');
    await replanNotifications(r.h.container, 'permission');
    expect(r.alert.scheduled).toHaveLength(1);
  });
});

describe('I-02 : place dans le plafond de 64 (critère 5, adaptateur réel sur faux pont)', () => {
  let r: Rig;
  beforeEach(async () => {
    const base = await rig('real');
    r = base;
  });
  afterEach(() => r.h.db.close());

  it('l’identifiant 2 est compté par reservedCount() : plan complet de 64 moins les réservés, ni replace ni cancelAll n’y touchent', async () => {
    const alert = createTauriSigningAlert(r.h.bridge);
    const container = reopenReminders(r.h, { mode: 'real', parts: { signing: { source: r.source, alert } } });
    r.source.expireAt(IN_6_DAYS);
    const outcome = await replanNotifications(container, 'open');
    expect(outcome.status).toBe('planned');
    expect([...r.h.bridge.pendingMap.keys()].filter((id) => id < 65_536)).toEqual([2]);
    expect(await container.notifications.reservedCount()).toBe(1);
    // 64 au total chez iOS : 63 du plan et l'alerte.
    expect(r.h.bridge.pendingMap.size).toBe(64);
    // Avec une session Focus en plus (identifiant 1) : 2 réservés, 62 du plan.
    r.h.bridge.pendingMap.set(1, { id: 1, title: 'Session terminée', body: '', date: '2026-10-08T10:25:00.000Z' });
    expect(await container.notifications.reservedCount()).toBe(2);
    await replanNotifications(container, 'resume');
    expect(r.h.bridge.pendingMap.size).toBe(64);
    // Le plan peut être vidé : l'alerte et la fin de Focus restent.
    await container.notifications.cancelAll();
    expect([...r.h.bridge.pendingMap.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    // Contenu envoyé au plugin : identifiant 2, sans catégorie, `sid` signing.
    const shown = r.h.bridge.shown.find((payload) => payload.id === 2);
    expect(shown).toMatchObject({ id: 2, sound: 'default', extra: { sid: 'signing' }, title: 'CircleTasks va expirer' });
    expect(shown).not.toHaveProperty('actionTypeId');
    expect(shown?.schedule.at.date).toBe('2026-10-13T10:00:00.000Z');
  });
});

describe('I-02 : moins de 24 h et expirée (critère 6)', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(() => r.h.db.close());

  it('moins de 24 h : aucune notification, bandeau « expire dans 10 h » ; l’état disparaît après une nouvelle échéance', async () => {
    r.source.expireAt('2026-10-08T18:00:00Z');
    await replanNotifications(r.h.container, 'open');
    expect(r.alert.scheduled).toHaveLength(0);
    expect(banner()).toMatchObject({ detail: 'soon', message: 'CircleTasks expire dans 10 h : actualisez-la dans SideStore' });
    // Actualisation par SideStore : nouvelle échéance à 7 jours, bandeau retiré, alerte planifiée.
    r.source.expireAt('2026-10-15T08:00:00Z');
    await replanNotifications(r.h.container, 'resume');
    expect(banner()).toBeUndefined();
    expect(r.alert.scheduled).toHaveLength(1);
  });

  it('sous une heure : durée en minutes', async () => {
    r.source.expireAt('2026-10-08T08:40:00Z');
    await replanNotifications(r.h.container, 'open');
    expect(banner()?.message).toBe('CircleTasks expire dans 40 min : actualisez-la dans SideStore');
  });

  it('l’alerte déjà planifiée est retirée quand l’échéance passe sous 24 h', async () => {
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    expect(r.alert.pending).not.toBeNull();
    r.source.expireAt('2026-10-08T20:00:00Z');
    await replanNotifications(r.h.container, 'resume');
    expect(r.alert.cancels).toBe(1);
    expect(r.alert.pending).toBeNull();
    expect((await storedSigning(r.h.container)).status.scheduled).toBeNull();
    expect(banner()?.detail).toBe('soon');
  });

  it('échéance passée : bandeau « La signature est expirée : réinstallez l’app »', async () => {
    r.source.expireAt('2026-10-08T07:00:00Z');
    await replanNotifications(r.h.container, 'open');
    expect(r.alert.scheduled).toHaveLength(0);
    expect(banner()).toMatchObject({ detail: 'expired', message: 'La signature est expirée : réinstallez l’app' });
  });

  it('le bandeau n’est pas une notification : un seul état, devant les autres bandeaux', async () => {
    r.source.expireAt('2026-10-08T18:00:00Z');
    await replanNotifications(r.h.container, 'open');
    const { pickAppStatus } = await import('../../domain/appStatus');
    expect(pickAppStatus(useAppStatusStore.getState().sources)).toBe('signingExpiry');
  });
});

describe('I-02 : aucun échec silencieux (critère 7)', () => {
  let r: Rig;
  let warn: MockInstance<(...data: unknown[]) => void>;
  beforeEach(async () => {
    r = await rig();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await r.h.db.close();
  });

  it('profil absent : état persistant « profile-missing », aucune alerte', async () => {
    r.source.fail('profile-missing');
    await replanNotifications(r.h.container, 'open');
    expect(r.alert.scheduled).toHaveLength(0);
    expect((await storedSigning(r.h.container)).status.failure).toEqual({ at: new Date(NOW).toISOString(), code: 'profile-missing' });
  });

  it('profil illisible ou commande refusée : « profile-unreadable », puis effacé à la première lecture réussie', async () => {
    r.source.fail('profile-unreadable');
    await replanNotifications(r.h.container, 'open');
    expect((await storedSigning(r.h.container)).status.failure?.code).toBe('profile-unreadable');
    r.source.fail('unavailable');
    await replanNotifications(r.h.container, 'resume');
    expect((await storedSigning(r.h.container)).status.failure?.code).toBe('profile-unreadable');
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'resume');
    expect((await storedSigning(r.h.container)).status.failure).toBeNull();
  });

  it('lecture en échec après une lecture réussie : l’alerte planifiée est gardée, l’échec est enregistré', async () => {
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    r.source.fail('profile-unreadable');
    await replanNotifications(r.h.container, 'resume');
    expect(r.alert.cancels).toBe(0);
    expect(r.alert.pending).not.toBeNull();
    const saved = (await storedSigning(r.h.container)).status;
    expect(saved.failure?.code).toBe('profile-unreadable');
    expect(saved.scheduled).toEqual({ instant: IN_6_DAYS_ALERT, expiresAt: IN_6_DAYS });
  });

  it('rejet de l’envoi : bandeau « Les rappels n’ont pas pu être planifiés » (chemin de N-01 critère 12), levé à l’envoi suivant', async () => {
    r.source.expireAt(IN_6_DAYS);
    r.alert.failSchedule = true;
    const outcome = await replanNotifications(r.h.container, 'open');
    expect(outcome.status).toBe('planned');
    expect(troubles()?.message).toBe('Les rappels n’ont pas pu être planifiés');
    // Un passage d'un autre déclencheur ne l'efface pas.
    await replanNotifications(r.h.container, 'edit');
    expect(troubles()?.message).toBe('Les rappels n’ont pas pu être planifiés');
    r.alert.failSchedule = false;
    await replanNotifications(r.h.container, 'resume');
    expect(troubles()).toBeUndefined();
    expect(r.alert.pending).not.toBeNull();
  });

  it('identifiant 2 absent de get_pending après l’envoi : même état visible', async () => {
    r.source.expireAt(IN_6_DAYS);
    r.alert.dropOnSchedule = true;
    await replanNotifications(r.h.container, 'open');
    expect(troubles()?.message).toBe('Les rappels n’ont pas pu être planifiés');
  });

  it('exception inattendue de la lecture : jamais un silence', async () => {
    vi.spyOn(r.source, 'read').mockRejectedValueOnce(new Error('inattendu'));
    await replanNotifications(r.h.container, 'open');
    expect(troubles()?.message).toBe('Les rappels n’ont pas pu être planifiés');
  });

  it('réglage illisible : journal « signing-status-unreadable », lu comme vide', async () => {
    await r.h.container.data.repos.settings.set('notifications.signing', { v: 7 });
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'open');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signing-status-unreadable'));
    expect((await storedSigning(r.h.container)).status.lastRead?.expiresAt).toBe(IN_6_DAYS);
  });

  it('le journal ne reçoit que des codes (jamais le texte de l’alerte ni de date)', async () => {
    r.source.fail('profile-unreadable');
    r.alert.failSchedule = true;
    await replanNotifications(r.h.container, 'open');
    r.source.expireAt(IN_6_DAYS);
    await replanNotifications(r.h.container, 'resume');
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('[desktop:signing]'))).toBe(true);
    for (const line of lines) expect(line).not.toMatch(/CircleTasks va expirer|Vérifiez|2026-10/);
  });
});

describe('I-02 : PC et navigateur', () => {
  it('source non prise en charge : aucune lecture, aucune alerte, aucun état écrit', async () => {
    const source = createFakeSigningSource(false);
    const alert = createFakeSigningAlert();
    const h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' }, parts: { signing: { source, alert } } });
    source.expireAt(IN_6_DAYS);
    const outcome = await replanNotifications(h.container, 'open');
    expect(outcome.status).toBe('pc');
    expect(source.reads).toBe(0);
    expect(alert.scheduled).toHaveLength(0);
    expect(banner()).toBeUndefined();
    expect(await h.container.data.repos.settings.get('notifications.signing')).toBeNull();
    await h.db.close();
  });
});
