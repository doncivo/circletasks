import { expect, test, type Locator, type Page } from '@playwright/test';
import { openSpacesScreen, projectsOf } from './helpers/spaces';
import { afterFirstFrames } from './helpers/frames';
import { createTask, openToday } from './helpers/today';

/**
 * UI-FIX-01 — thème sombre lisible (audit B11), projets `pc` et `iphone`, thèmes sombre puis clair.
 *
 * jsdom ne charge aucun CSS : les couleurs sont lues ici dans le navigateur réel (`getComputedStyle`), avec le fond effectif obtenu en
 * remontant les ancêtres jusqu'à un fond opaque. Critère 13 : bandeau « Annuler » (texte >= 4,5:1), bouton principal des projets (texte
 * >= 4,5:1), interrupteur activé (piste >= 3:1 sur son parent, pouce >= 3:1 sur la piste). Critère 21 : interrupteur éteint actif et
 * interrupteur désactivé côte à côte (curseur, pouce creux, bordure, opacité), clic sans effet sur le désactivé, trois signatures de
 * style calculé deux à deux différentes.
 */

type Rgba = readonly [number, number, number, number];

const parseRgba = (value: string): Rgba => {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) throw new Error(`couleur calculée inattendue : ${value}`);
  const [r = 0, g = 0, b = 0, a = 1] = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
};

const lum = ([r, g, b]: Rgba): number => {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const ratio = (a: Rgba, b: Rgba): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

interface Computed {
  color: string;
  background: string;
  /** Fond opaque effectif derrière l'élément (ancêtres composés jusqu'à un fond opaque, blanc par défaut du navigateur sinon). */
  behind: string;
  cursor: string;
  opacity: string;
  borderWidth: string;
}

/** Styles calculés d'un élément et fond effectif de son parent. */
async function computed(locator: Locator): Promise<Computed> {
  return locator.evaluate((el): Computed => {
    const layers: string[] = [];
    for (let node = el.parentElement; node; node = node.parentElement) layers.push(getComputedStyle(node).backgroundColor);
    const parse = (v: string): number[] => (/rgba?\(([^)]+)\)/.exec(v)?.[1] ?? '0,0,0,0').split(/[\s,/]+/).filter(Boolean).map(Number);
    let acc = [255, 255, 255];
    for (const layer of [...layers].reverse()) {
      const [r = 0, g = 0, b = 0, a = 1] = parse(layer);
      acc = [r * a + (acc[0] ?? 255) * (1 - a), g * a + (acc[1] ?? 255) * (1 - a), b * a + (acc[2] ?? 255) * (1 - a)];
    }
    const style = getComputedStyle(el);
    return {
      color: style.color,
      background: style.backgroundColor,
      behind: `rgb(${acc.map(Math.round).join(', ')})`,
      cursor: style.cursor,
      opacity: style.opacity,
      borderWidth: style.borderTopWidth,
    };
  });
}

/** Fond effectif de l'élément lui-même : son fond s'il est opaque, sinon le fond derrière lui. */
const own = (c: Computed): Rgba => {
  const bg = parseRgba(c.background);
  return bg[3] === 1 ? bg : parseRgba(c.behind);
};

async function openTabsScreen(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await page.getByRole('button', { name: /^Onglets : / }).click();
  await expect(page.getByRole('heading', { name: 'Onglets' })).toBeVisible();
}

const sw = (page: Page, tab: string): Locator => page.getByRole('switch', { name: `Afficher ${tab}`, exact: true });

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`thème ${scheme === 'dark' ? 'sombre' : 'clair'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openToday(page);
    });

    test('bandeau « Annuler » : texte lisible sur son fond (critère 13)', async ({ page }, testInfo) => {
      await createTask(page, testInfo, { title: 'Tâche du bandeau' });
      await page.getByRole('checkbox', { name: 'Terminer : Tâche du bandeau' }).click();
      const toast = page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Annuler' }) });
      await expect(toast).toBeVisible();
      await afterFirstFrames(page);
      const c = await computed(toast);
      // Mêmes planchers que le test statique (contrastCss.test.ts) : 14:1 en clair, 17:1 en sombre.
      expect(ratio(parseRgba(c.color), own(c)), `texte ${c.color} sur ${c.background}`).toBeGreaterThanOrEqual(scheme === 'dark' ? 17 : 14);
    });

    test('bouton principal de l’écran des espaces et projets : texte lisible (critère 13)', async ({ page }) => {
      await openSpacesScreen(page);
      const zone = projectsOf(page, 'Pro');
      await zone.getByRole('button', { name: 'Ajouter un projet' }).click();
      const primary = zone.locator('.ct-projects__button--primary');
      await expect(primary).toBeVisible();
      await afterFirstFrames(page);
      const c = await computed(primary);
      expect(ratio(parseRgba(c.color), own(c)), `texte ${c.color} sur ${c.background}`).toBeGreaterThanOrEqual(scheme === 'dark' ? 17 : 14);
    });

    test('interrupteur activé : piste et pouce lisibles (critère 13)', async ({ page }) => {
      await openTabsScreen(page);
      const on = sw(page, 'Semaine');
      await expect(on).toHaveAttribute('aria-checked', 'true');
      await afterFirstFrames(page);
      const track = await computed(on.locator('.ct-switch__track'));
      const thumb = await computed(on.locator('.ct-switch__thumb'));
      expect(ratio(own(track), parseRgba(track.behind)), `piste ${track.background} sur ${track.behind}`).toBeGreaterThanOrEqual(3);
      expect(ratio(parseRgba(thumb.background), parseRgba(track.background)), `pouce ${thumb.background} sur ${track.background}`).toBeGreaterThanOrEqual(3);
    });

    test('interrupteur désactivé distinct de l’éteint (critère 21)', async ({ page }) => {
      await openTabsScreen(page);
      const active = sw(page, 'Semaine');
      const off = sw(page, 'Routines');
      const locked = sw(page, 'Tâches');
      await off.click();
      await expect(off).toHaveAttribute('aria-checked', 'false');
      await expect(locked).toBeDisabled();
      await expect(locked).toHaveAttribute('aria-checked', 'true');
      // Clic sur l’interrupteur désactivé : aucun changement d’état.
      await locked.click({ force: true });
      await expect(locked).toHaveAttribute('aria-checked', 'true');
      await afterFirstFrames(page);

      const read = async (button: Locator) => {
        const b = await computed(button);
        const t = await computed(button.locator('.ct-switch__thumb'));
        const k = await computed(button.locator('.ct-switch__track'));
        return { cursor: b.cursor, opacity: b.opacity, thumbBackground: t.background, thumbBorder: t.borderWidth, track: k.background };
      };
      // Les trois lectures des vrais interrupteurs se font AVANT la copie : elle porterait le même nom accessible (mode strict de getByRole).
      const signatures = { active: await read(active), off: await read(off), locked: await read(locked) };

      // Désactivé-éteint : copie du DOM d’un interrupteur éteint dont on pose l’attribut `disabled` (aucune page de démonstration dans l’app).
      // La copie reçoit un nom accessible distinct et se désigne par son attribut, jamais par `getByRole`.
      await off.evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLButtonElement;
        copy.disabled = true;
        copy.setAttribute('aria-label', 'Copie désactivée (test UI-FIX-01)');
        copy.setAttribute('data-ui-fix-01-copy', 'true');
        el.after(copy);
      });
      const copy = page.locator('[data-ui-fix-01-copy]');
      await expect(copy).toBeDisabled();
      const lockedOff = await read(copy);

      // Éteint actif : curseur main, pouce plein et opaque, sans bordure, opacité 1.
      expect(signatures.off.cursor).toBe('pointer');
      expect(parseRgba(signatures.off.thumbBackground)[3]).toBe(1);
      expect(signatures.off.thumbBorder).toBe('0px');
      expect(signatures.off.opacity).toBe('1');
      // Désactivé : curseur interdit, pouce creux, bordure de 2 px, opacité 0,5.
      for (const state of [lockedOff, signatures.locked]) {
        expect(state.cursor).toBe('not-allowed');
        expect(parseRgba(state.thumbBackground)[3]).toBe(0);
        expect(state.thumbBorder).toBe('2px');
        expect(state.opacity).toBe('0.5');
      }
      // Trois états (activé, éteint, désactivé-éteint) : signatures deux à deux différentes.
      const sig = (s: typeof lockedOff): string => JSON.stringify(s);
      expect(new Set([sig(signatures.active), sig(signatures.off), sig(lockedOff)]).size).toBe(3);
    });
  });
}
