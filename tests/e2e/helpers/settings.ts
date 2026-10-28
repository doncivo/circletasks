import { expect, type Locator, type Page } from '@playwright/test';

type TestInfo = { readonly project: { readonly name: string } };
const isPhone = (testInfo: TestInfo): boolean => testInfo.project.name === 'iphone';

/**
 * UI-REFONTE-09 : sur PC, les sections de Réglages portent des titres en minuscules (sommaire et colonne, PC-Reglages.html) ; l'iPhone garde
 * les capitales de Reglages.html. Même clé, deux libellés.
 */
const SECTIONS = {
  general: ['GÉNÉRAL', 'Général'],
  tasks: ['TÂCHES', 'Tâches'],
  reminders: ['RAPPELS', 'Rappels'],
  spaces: ['ESPACES ET CALENDRIERS', 'Espaces et agendas'],
  sync: ['SYNCHRONISATION', 'Synchronisation'],
  data: ['DONNÉES ET SÉCURITÉ', 'Sauvegardes et données'],
  keyboard: ['CLAVIER', 'Clavier'],
  about: ['À PROPOS', 'À propos'],
} as const;

export type SettingsSectionKey = keyof typeof SECTIONS;

/** Titre de section tel qu'il s'affiche sur l'appareil du test. */
export const settingsSectionTitle = (testInfo: TestInfo, key: SettingsSectionKey): string => SECTIONS[key][isPhone(testInfo) ? 0 : 1];

/** Titre `h2` d'une section de Réglages (sommaire PC exclu : il porte des boutons, pas des titres). */
export const settingsSectionHeading = (page: Page, testInfo: TestInfo, key: SettingsSectionKey): Locator =>
  page.getByRole('heading', { level: 2, name: settingsSectionTitle(testInfo, key), exact: true });

/** Ligne qui ouvre « Apparence et formats » : « Thème · semaine · heure » sur iPhone, « Thème : … » sur PC (UI-REFONTE-09, trois lignes). */
export const appearanceRow = (page: Page, testInfo: TestInfo): Locator =>
  page.getByRole('button', { name: isPhone(testInfo) ? /^Thème · semaine · heure/ : /^Thème : / });

/** Ligne « Onglets » de Réglages : « Onglets : 5 visibles » sur iPhone, « Onglets visibles : 5 sur 5 » sur PC (UI-REFONTE-09, Réglages non compté). */
export const tabsRow = (page: Page, testInfo: TestInfo, visible?: number): Locator =>
  page.getByRole('button', {
    name: visible === undefined ? (isPhone(testInfo) ? /^Onglets : / : /^Onglets visibles : /) : isPhone(testInfo) ? `Onglets : ${visible} visibles` : `Onglets visibles : ${visible} sur 5`,
  });

/** Résumé d'apparence de Réglages après un choix : une ligne « Thème · semaine · heure : … » sur iPhone, deux lignes sur PC. */
export async function expectAppearanceSummary(page: Page, testInfo: TestInfo, weekday: string, format: string): Promise<void> {
  if (isPhone(testInfo)) {
    await expect(page.getByRole('button', { name: new RegExp(`Système · ${weekday} · ${format}`) })).toBeVisible();
    return;
  }
  const capitalized = weekday.charAt(0).toLocaleUpperCase('fr-FR') + weekday.slice(1);
  await expect(page.getByRole('button', { name: `Début de semaine : ${capitalized}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Format de l’heure : ${format}` })).toBeVisible();
}

/** Fuseau horaire de Réglages : « Europe/Paris (automatique) » sur iPhone ; sur PC la valeur seule, « Suit celui de Windows » sous l'étiquette. */
export async function expectTimeZone(page: Page, testInfo: TestInfo, zone: string): Promise<void> {
  if (isPhone(testInfo)) {
    await expect(page.getByText(`${zone} (automatique)`)).toBeVisible();
    return;
  }
  await expect(page.getByText(zone, { exact: true })).toBeVisible();
  await expect(page.getByText('Suit celui de Windows')).toBeVisible();
}
