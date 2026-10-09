import { expect, test } from '@playwright/test';
import { waitForScreenLoaded } from './helpers/app';
import { openToday } from './helpers/today';

/**
 * K-01 D1 (défaut vu sur l'iPhone en 0.2.3) : un compte iCloud connecté sur le PC arrive sur l'iPhone par la synchro (ligne
 * `calendar_account` sans référence du coffre locale : `token_ref` n'est jamais publié). L'iPhone ne détient pas le mot de passe
 * d'application : le compte est « Connecté ailleurs », jamais « Agenda … déconnecté » dans le bandeau. Le bandeau de l'appareil qui
 * détient le compte et l'a perdu reste couvert par K-01.spec.ts et K-02.spec.ts (jeton ou mot de passe révoqué).
 */
test('K-01 : iPhone, compte iCloud reçu du PC sans secret local : « Connecté ailleurs », aucun bandeau « déconnecté »', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  await openToday(page);
  // Ligne telle que la synchro la crée sur l'iPhone : colonnes publiées seulement, `token_ref` et `username` locaux vides.
  await page.evaluate(async () => {
    await window.__ctTest?.seedCalendarAccount({ id: 'acc-icloud-pc', provider: 'icloud', label: '', calendars: [] });
  });
  await waitForScreenLoaded(page, 'settingsscreen');
  await waitForScreenLoaded(page, 'calendarsscreen');
  await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
  await page.getByRole('button', { name: /^Agendas · Rappels Apple/ }).click();
  const card = page.getByRole('region', { name: 'iCloud · Compte iCloud' });
  await expect(card.getByText('Connecté ailleurs')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Connecter Compte iCloud sur cet appareil' })).toBeVisible();
  await expect(card.getByText('Déconnecté', { exact: true })).toHaveCount(0);
  await expect(page.locator('.ct-status-banner').filter({ hasText: 'déconnecté' })).toHaveCount(0);
  await expect(page.getByText('Agenda Compte iCloud déconnecté')).toHaveCount(0);
});
