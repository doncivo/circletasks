import { SystemSettingsError, type SystemSettings } from './index';

/** Faux ouvreur des Réglages : enregistre les appels, échec possible (`settings-open-failed`). */
export interface FakeSystemSettings extends SystemSettings {
  fail: boolean;
  opened: number;
}

export function createFakeSystemSettings(fail = false): FakeSystemSettings {
  const fake: FakeSystemSettings = {
    fail,
    opened: 0,
    openApp: () => {
      fake.opened += 1;
      return fake.fail ? Promise.reject(new SystemSettingsError()) : Promise.resolve();
    },
  };
  return fake;
}
