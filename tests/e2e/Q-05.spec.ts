import { expect, test } from '@playwright/test';
import { APP_READY_TIMEOUT_MS, openApp } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { isPhone, listTitles, openToday } from './helpers/today';

/**
 * Q-05 — Je capture vite depuis l'iPhone (critères 3, 8, 9 et 6).
 *
 * Projet `iphone` : un toucher sur « + », le champ « Titre » est focalisé dans le même passage (ce qui fait monter le clavier iOS), « Acheter
 * du pain #perso » puis Entrée crée la tâche (thèmes clair et sombre), « Enregistrer » reste visible quand le clavier réduit la fenêtre,
 * le bouton + n'est pas atteignable derrière l'assistant de premier lancement. Projet `pc` : comportement inchangé (champ en ligne).
 * Les mesures de temps (critère 6) sont dans le test @perf de ce fichier.
 */
test.describe('Q-05 — capture rapide', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`iPhone, thème ${scheme} : toucher sur +, saisie, Entrée, tâche dans la liste (critère 9)`, async ({ page }, testInfo) => {
      test.skip(!isPhone(testInfo), 'La feuille « Nouvelle tâche » est celle de l’iPhone.');
      await page.emulateMedia({ colorScheme: scheme });
      await openToday(page);
      await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
      const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
      const field = dialog.getByLabel('Titre');
      // Critère 3 : focus posé dans le traitement du toucher, pas dans une minuterie.
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute('enterkeyhint', 'done');
      await page.keyboard.type('Acheter du pain #perso');
      await page.keyboard.press('Enter');
      await expect(dialog).not.toBeVisible();
      expect(await listTitles(page)).toContain('Acheter du pain');
    });
  }

  test('iPhone : le focus est dans le champ dès le retour du gestionnaire du toucher (critère 3)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La feuille « Nouvelle tâche » est celle de l’iPhone.');
    await openToday(page);
    const focused = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Ajouter');
      if (!button) throw new Error('bouton + introuvable');
      button.click();
      // Aucun await : le focus doit déjà être posé quand `click()` rend la main.
      const active = document.activeElement;
      return { label: active?.getAttribute('aria-label') ?? active?.closest('label')?.textContent ?? '', tag: active?.tagName ?? '' };
    });
    expect(focused.tag).toBe('INPUT');
  });

  test('iPhone : clavier simulé qui réduit la fenêtre, « Enregistrer » reste visible (critère 9)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La feuille « Nouvelle tâche » est celle de l’iPhone.');
    await openToday(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(dialog.getByLabel('Titre')).toBeFocused();
    const height = 520;
    await page.setViewportSize({ width: 440, height });
    const save = dialog.getByRole('button', { name: 'Enregistrer' });
    await expect(save).toBeVisible();
    const box = await save.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  });

  test('iPhone 440 × 956 : la feuille de capture ne défile pas à l’horizontale, même avec un titre très long et un mot sans espace', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La feuille « Nouvelle tâche » est celle de l’iPhone.');
    await openToday(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(dialog.getByLabel('Titre')).toBeFocused();
    // Le bas de la feuille arrive à l'image suivante (transition) : mesuré une fois monté.
    await expect(dialog.locator('.ct-icon-picker')).toBeVisible();
    await expectFitsViewport(page, 'feuille de capture vide');
    await dialog.getByLabel('Titre').fill(`Appeler le notaire demain 10h #perso ${'ExtraordinairementLong'.repeat(8)}`);
    await expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    await expectFitsViewport(page, 'feuille de capture, titre long');
  });

  test('iPhone : derrière l’assistant de premier lancement, le bouton + n’est pas atteignable (critère 8 de la fiche)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'L’assistant plein écran est celui de l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctOnboarding?: boolean }).__ctOnboarding = true;
    });
    await openApp(page);
    const guide = page.getByRole('dialog', { name: 'Guide de bienvenue' });
    await expect(guide).toBeVisible();
    const covered = await page.evaluate(() => {
      const fab = document.querySelector('.ct-fab');
      if (!fab) return 'absent';
      const rect = fab.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && fab.contains(hit) ? 'atteignable' : 'couvert';
    });
    expect(covered).not.toBe('atteignable');
    await guide.getByRole('button', { name: 'Passer le guide de bienvenue' }).click();
    await expect(guide).not.toBeVisible();
    await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByLabel('Titre')).toBeFocused();
  });

  test('PC : comportement inchangé, le champ en ligne prend le focus et aucune feuille ne s’ouvre (critère 9)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Comportement du projet pc.');
    await openToday(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByLabel('Nouvelle tâche')).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toHaveCount(0);
  });
});

/**
 * Critère 6 (PRD 8) — projet `perf` (tag @perf), émulation CPU 4× et écran de l'iPhone. Du toucher à la feuille AFFICHÉE (image suivante
 * et minuterie passées) avec le champ déjà focalisé : médiane de cinq essais sous 300 ms, sur le build de production. Le démarrage à froid est
 * mesuré du début de la navigation à la présence du bouton + (base en mémoire du navigateur) : valeur consignée dans l'annotation « mesure »
 * sans seuil de 1 s ; ce seuil se contrôle sur l'appareil (A2 de la fiche).
 */
test.describe('Q-05 — mesures iPhone @perf', () => {
  test.use({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

  test('lancement jusqu’au bouton + utilisable, CPU 4× (mesure consignée) @perf', async ({ page }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/');
    await expect(page.locator('.ct-fab')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    const launchMs = await page.evaluate(() => performance.now());
    testInfo.annotations.push({ type: 'mesure', description: `lancement jusqu’au bouton + : ${String(Math.round(launchMs))} ms (navigateur, base en mémoire, CPU 4× : le seuil de 1 s se contrôle sur l’appareil, A2)` });
    expect(launchMs).toBeGreaterThan(0);
  });

  test('toucher du bouton + jusqu’à la feuille focalisée sous 300 ms, médiane de 5 essais, CPU 4× @perf', async ({ page }, testInfo) => {
    await openToday(page);
    // Le ralentissement du processeur ne vaut que pour la mesure : le chargement à froid par le serveur de développement n'y entre pas.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const timings: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Mesure prise page au repos : les lectures de base lancées par la fermeture précédente sont terminées (attente d'un état, pas d'un délai).
      await page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve())));
      const elapsed = await page.evaluate(async () => {
        const button = document.querySelector<HTMLButtonElement>('.ct-fab');
        if (!button) throw new Error('bouton + introuvable');
        const begin = performance.now();
        // Demandée AVANT le toucher : son rappel passe avant ceux que la feuille enregistre (calage et déploiement de la roue des jours), donc la
        // minuterie qui clôt la mesure précède la leur. Image puis minuterie : la feuille est rendue, mise en page et peinte.
        const shown = new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        button.click();
        // Le focus est posé dans le geste : vérifié dès le retour du clic, avant toute image.
        const active = document.activeElement;
        if (!(active instanceof HTMLInputElement) || !active.closest('[role="dialog"]')) throw new Error('champ non focalisé au retour du toucher');
        // Feuille AFFICHÉE (revue I3) : fin de la mesure après l'image qui suit le toucher (rendu, mise en page et peinture faits), puis une minuterie.
        await shown;
        return performance.now() - begin;
      });
      timings.push(elapsed);
      await page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByRole('button', { name: 'Fermer' }).click();
      await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toHaveCount(0);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
    testInfo.annotations.push({ type: 'mesure', description: `toucher jusqu’au champ focalisé : médiane ${String(Math.round(median))} ms (essais : ${timings.map((v) => String(Math.round(v))).join(' / ')} ms, CPU 4×)` });
    // Le projet `perf` sert le BUNDLE DE PRODUCTION (playwright.config.ts : dist-perf, React en mode production) : le seuil vaut pour l'app
    // installée et s'applique sans condition. Un projet qui retomberait sur le serveur de développement (script /@vite/client) fait échouer le test.
    const development = await page.evaluate(() => document.querySelector('script[src*="/@vite/client"]') !== null);
    expect(development, 'le projet perf doit tourner sur le bundle de production').toBe(false);
    expect(median).toBeLessThan(300);
  });
});
