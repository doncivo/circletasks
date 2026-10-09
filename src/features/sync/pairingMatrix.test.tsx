// @vitest-environment jsdom
// Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2) : matrice « état × plateforme × écran ». Pour chaque état possible de
// l'association, Réglages › Synchronisation, Détails et le bandeau A-09 offrent l'action utile et aucune action inutile ou dangereuse
// (« Réinitialiser » sans clé, « Synchroniser » sans clé, QR sur l'iPhone…). Moteur et plateforme réels (mémoire) quand l'état se produit
// par un vrai cycle ; faux service seulement pour les phases qui demandent un second appareil actif (réinitialisation, oubli).
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settle } from '../../../tests/setup/settle';
import { SyncSettingsSection } from './SyncSettingsSection';
import {
  BANNER_MISMATCH,
  BANNER_NEEDS,
  associate,
  ACTIONS,
  backgroundThenForeground,
  renderIn,
  visibleActions,
  chooseEmptyFolder,
  closeRig,
  current,
  dataNoKey,
  fakePhase,
  harness,
  keyEqual,
  keyMismatch,
  observe,
  openRig,
  restart,
  type Action,
  type Harness,
  type Os,
} from '../../../tests/fixtures/pairingMatrixKit';
import { PAIRING_PHONE_ID as SELF } from '../../../tests/fixtures/pairingWorld';
import { SyncPlatformError, type SyncPlatform } from '../../platform/sync';
import { DbError } from '../../db/driver';
import type { DataAccess } from '../../db/repositories';

beforeEach(async () => {
  await openRig();
});

afterEach(async () => {
  await closeRig();
});

interface Expectation {
  readonly settings: Action[];
  readonly details: Action[];
  readonly banner?: string | null;
}

interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly build: (os: Os) => Promise<Harness>;
  readonly expected: Partial<Record<Os, Expectation>>;
  /** Le même écran après une relance de l'app (aucun cycle encore) : vrai si l'état est celui d'avant, sans attendre un cycle. */
  readonly sameAfterRestart?: boolean;
}

const ASSOCIATED: Record<Os, Expectation> = {
  windows: { settings: ['details', 'forgetFolder', 'showQr', 'syncNow'], details: ['reset', 'showQr', 'syncNow'], banner: null },
  ios: { settings: ['details', 'forgetFolder', 'syncNow'], details: ['reset', 'syncNow'], banner: null },
};

/** Base dont la lecture de  échoue (« database is locked », constat de la 0.2.1 sur l'iPhone). */
function lockedData(): DataAccess {
  const { db } = current();
  const locked = new Proxy(db.data.repos.sync, {
    get(target, prop, receiver) {
      if (prop === 'getMeta') return () => Promise.reject(new DbError('busy', 'database is locked'));
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...db.data, repos: { ...db.data.repos, sync: locked } };
}

const SCENARIOS: Scenario[] = [
  {
    id: 'E01',
    title: 'aucun dossier choisi : seul le choix du dossier (iPhone : et l’écran d’association, qui commence par le dossier)',
    build: async (os) => harness(await current().world.device(os, SELF, false), os),
    expected: {
      windows: { settings: ['choose'], details: [], banner: null },
      ios: { settings: ['associatePhone', 'choose'], details: [], banner: null },
    },
    sameAfterRestart: true,
  },
  {
    id: 'E02',
    title: 'dossier vide choisi : PC, clé créée ; iPhone, jamais de clé créée (le dossier peut ne pas être encore listé par iCloud)',
    build: chooseEmptyFolder,
    expected: {
      windows: ASSOCIATED.windows,
      ios: { settings: ['associatePhone', 'forgetFolder', 'startNew'], details: ['associatePhone'], banner: BANNER_NEEDS('ios') },
    },
  },
  {
    id: 'E03',
    title: 'dossier avec les données du PC, pas de clé : association seulement, ni synchroniser ni réinitialiser ni QR',
    build: (os) => dataNoKey(os),
    expected: {
      windows: { settings: ['associatePc', 'forgetFolder'], details: ['associatePc'], banner: BANNER_NEEDS('windows') },
      ios: { settings: ['associatePhone', 'forgetFolder', 'startNew'], details: ['associatePhone'], banner: BANNER_NEEDS('ios') },
    },
    sameAfterRestart: true,
  },
  {
    id: 'E04',
    title: 'clé présente mais différente de celle du dossier (key-mismatch) : association, jamais réinitialiser',
    build: (os) => keyMismatch(os),
    expected: {
      windows: { settings: ['associatePc', 'details', 'forgetFolder', 'syncNow'], details: ['associatePc', 'syncNow'], banner: BANNER_MISMATCH },
      ios: { settings: ['associatePhone', 'details', 'forgetFolder', 'syncNow'], details: ['associatePhone', 'syncNow'], banner: BANNER_MISMATCH },
    },
  },
  {
    id: 'E05',
    title: 'clé présente et égale à celle du dossier, synchronisé : état normal (QR sur PC seulement)',
    build: (os) => keyEqual(os),
    expected: ASSOCIATED,
    sameAfterRestart: true,
  },
  {
    id: 'E06',
    title: 'Trousseau verrouillé (vault-unavailable) sur un appareil déjà associé : relire, rien de destructeur',
    build: async (os) => {
      const platform = await current().world.device(os, SELF, true);
      await associate(platform, os, await current().world.qr());
      platform.testing.setVaultAvailable(false);
      return harness(platform, os);
    },
    expected: {
      // PC : « Associer l’iPhone » reste offert alors que le coffre est illisible (défaut D3, pairingDefects.test.tsx).
      ios: { settings: ['forgetFolder', 'rereadFolder'], details: ['syncNow'], banner: 'Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra' },
    },
  },
  {
    id: 'E12',
    title: 'Trousseau verrouillé avant même de savoir si la clé est là : relire, ni association ni réinitialisation devinées',
    build: async (os) => {
      const platform = await current().world.device(os, SELF, true);
      platform.testing.setVaultAvailable(false);
      return harness(platform, os);
    },
    expected: {
      // PC : « Associer l’iPhone » reste offert, coffre illisible (défaut D3, pairingDefects.test.tsx).
      ios: { settings: ['forgetFolder', 'rereadFolder'], details: ['syncNow'], banner: 'Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra' },
    },
  },
  {
    id: 'E13',
    title: 'arrivée interrompue (join en échec, mémorisée) : « Réessayer » dans Réglages et dans Détails, bandeau',
    build: async (os) => {
      const platform = await current().world.device(os, SELF, true);
      await associate(platform, os, await current().world.qr());
      await current().db.data.repos.sync.setMeta('join', JSON.stringify({ done: 3, total: 10, failure: 'io' }));
      return harness(platform, os, { fake: { phase: 'idle' } });
    },
    expected: {
      windows: { settings: ['details', 'forgetFolder', 'retryJoin', 'showQr', 'syncNow'], details: ['reset', 'retryJoin', 'showQr', 'syncNow'] },
      ios: { settings: ['details', 'forgetFolder', 'retryJoin', 'syncNow'], details: ['reset', 'retryJoin', 'syncNow'] },
    },
  },
  {
    id: 'E14',
    title: 'base locale illisible (database is locked) alors que la clé est là : erreur visible, jamais « à associer »',
    build: async (os) => {
      const platform = await current().world.device(os, SELF, true);
      await associate(platform, os, await current().world.qr());
      return harness(platform, os, { data: lockedData() });
    },
    expected: {
      windows: { settings: ['details', 'forgetFolder', 'showQr', 'syncNow'], details: ['reset', 'showQr', 'syncNow'] },
      ios: { settings: ['details', 'forgetFolder', 'syncNow'], details: ['reset', 'syncNow'] },
    },
  },
  {
    id: 'E15',
    title: 'dossier injoignable (signet perdu, dossier déplacé) : iPhone, « Choisir le dossier » de nouveau ; PC, relire ou oublier',
    build: async (os) => {
      const platform = await current().world.device(os, SELF, true);
      await associate(platform, os, await current().world.qr());
      const failing: SyncPlatform = { ...platform, folder: { ...platform.folder, info: () => Promise.reject(new SyncPlatformError('folder-unreachable')) } };
      return harness(failing, os, { fake: { phase: 'error', errorCode: 'folder-unreachable' } });
    },
    expected: {
      windows: { settings: ['forgetFolder', 'rereadFolder'], details: ['reset', 'showQr', 'syncNow'], banner: 'Dossier de synchro introuvable : vos modifications seront envoyées au retour' },
      ios: { settings: ['choose', 'forgetFolder', 'rereadFolder'], details: ['reset', 'syncNow'], banner: 'Dossier iCloud Drive inaccessible : choisissez de nouveau le dossier iCloud Drive / CircleTasks' },
    },
  },
  {
    id: 'E07',
    title: 'réinitialisation faite sur l’autre appareil (reset-required) : association de nouveau, jamais réinitialiser',
    build: (os) => fakePhase(os, { phase: 'reset-required', errorCode: null }),
    expected: {
      windows: { settings: ['associatePc', 'details', 'forgetFolder', 'syncNow'], details: ['associatePc', 'syncNow'], banner: 'Cet appareil doit être associé de nouveau' },
      ios: { settings: ['associatePhone', 'details', 'forgetFolder', 'syncNow'], details: ['associatePhone', 'syncNow'], banner: 'Cet appareil doit être associé de nouveau' },
    },
  },
  {
    id: 'E08',
    title: 'oublié par l’autre appareil (forgotten) : « Associer de nouveau » dans Détails',
    build: (os) => fakePhase(os, { phase: 'forgotten', errorCode: null }),
    expected: {
      // PC : « Associer l’iPhone » reste offert à un appareil oublié (défaut D1, pairingDefects.test.tsx).
      ios: { settings: ['details', 'forgetFolder', 'syncNow'], details: ['rejoin', 'syncNow'], banner: 'Cet appareil a été oublié : associez-le de nouveau' },
    },
  },
  {
    id: 'E09',
    title: 'erreur passagère (io) : relire par « Synchroniser », rien de destructeur proposé en plus',
    build: (os) => fakePhase(os, { phase: 'error', errorCode: 'io' }),
    expected: {
      windows: { settings: ['details', 'forgetFolder', 'showQr', 'syncNow'], details: ['reset', 'showQr', 'syncNow'], banner: 'La synchronisation a échoué : nouvel essai au prochain cycle' },
      ios: { settings: ['details', 'forgetFolder', 'syncNow'], details: ['reset', 'syncNow'], banner: 'La synchronisation a échoué : nouvel essai au prochain cycle' },
    },
  },
  {
    id: 'E11',
    title: 'en attente d’iCloud (cloud-pending) : aucune alarme, état normal',
    build: (os) => fakePhase(os, { phase: 'waiting-icloud', errorCode: 'cloud-pending' }),
    expected: {
      windows: { settings: ['details', 'forgetFolder', 'showQr', 'syncNow'], details: ['reset', 'showQr', 'syncNow'], banner: 'iCloud ne répond pas : vos modifications seront envoyées au retour' },
      ios: { settings: ['details', 'forgetFolder', 'syncNow'], details: ['reset', 'syncNow'], banner: 'iCloud ne répond pas : vos modifications seront envoyées au retour' },
    },
  },
];

describe('matrice de l’association : état × plateforme × écran (Y-IOS-02)', () => {
  for (const scenario of SCENARIOS) {
    for (const os of ['windows', 'ios'] as const) {
      const expected = scenario.expected[os];
      if (!expected) continue;
      const where = os === 'ios' ? 'iPhone' : 'PC';
      it(`Y-IOS-02 ${scenario.id} ${scenario.title} — ${where}`, async () => {
        const h = await scenario.build(os);
        expect(await observe(h)).toMatchObject(expected);
        h.integration.dispose();
      });
      if (scenario.sameAfterRestart) {
        it(`Y-IOS-02 ${scenario.id} relance de l’app, avant tout cycle : mêmes actions — ${where}`, async () => {
          const first = await scenario.build(os);
          const again = await restart(first, { noCycle: true });
          const seen = await observe(again);
          expect(seen.settings).toEqual(expected.settings);
          again.integration.dispose();
        });
      }
    }
  }
});

describe('Y-IOS-02 retour au premier plan : l’action utile reste, rien ne boucle', () => {
  for (const os of ['windows', 'ios'] as const) {
    const where = os === 'ios' ? 'iPhone' : 'PC';
    it(`Y-IOS-02 F01 sans clé (E03), après un passage en arrière-plan : mêmes actions, même bandeau — ${where}`, async () => {
      const h = await dataNoKey(os, { realDocument: true });
      const before = await observe(h);
      await backgroundThenForeground(h);
      expect(await observe(h)).toEqual(before);
      expect(h.container.sync?.status().phase).toBe('needs-pairing');
      h.integration.dispose();
    });
    it(`Y-IOS-02 F02 clé différente (E04), après un passage en arrière-plan : association toujours proposée — ${where}`, async () => {
      const h = await keyMismatch(os, { realDocument: true });
      const before = await observe(h);
      await backgroundThenForeground(h);
      const after = await observe(h);
      expect(after).toEqual(before);
      expect(after.settings).toContain(os === 'ios' ? 'associatePhone' : 'associatePc');
      h.integration.dispose();
    });
    it(`Y-IOS-02 F03 Trousseau déverrouillé pendant l’arrière-plan (E06) : retour au premier plan, l’état redevient normal — ${where}`, async () => {
      const platform = await current().world.device(os, SELF, true);
      await associate(platform, os, await current().world.qr());
      platform.testing.setVaultAvailable(false);
      const h = await harness(platform, os, { realDocument: true });
      expect((await observe(h)).settings).toEqual(['forgetFolder', 'rereadFolder']);
      platform.testing.setVaultAvailable(true);
      await backgroundThenForeground(h);
      const seen = await observe(h);
      expect(seen.settings).toEqual(ASSOCIATED[os].settings);
      expect(seen.banner).toBeNull();
      h.integration.dispose();
    });
    it(`Y-IOS-02 F04 « Oublier le dossier et la clé », puis le même dossier : à associer, jamais une clé recréée — ${where}`, async () => {
      const h = await keyEqual(os);
      renderIn(h.container, <SyncSettingsSection />);
      await settle(current().db.driver);
      fireEvent.click(screen.getByRole('button', { name: ACTIONS.forgetFolder }));
      fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier et la clé' }));
      await settle(current().db.driver);
      expect(visibleActions()).toEqual(os === 'ios' ? ['associatePhone', 'choose'] : ['choose']);
      fireEvent.click(screen.getByRole('button', { name: ACTIONS.choose }));
      await settle(current().db.driver);
      expect(visibleActions()).toEqual(os === 'ios' ? ['associatePhone', 'forgetFolder', 'startNew'] : ['associatePc', 'forgetFolder']);
      expect((await h.platform.key.status()).present).toBe(false);
      cleanup();
      h.integration.dispose();
    });
  }
});
