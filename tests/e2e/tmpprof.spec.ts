import { test } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { openToday } from './helpers/today';
test.use({ viewport: { width: 440, height: 956 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
test('prof @perf', async ({ page, browser }) => {
  await openToday(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (document.querySelector('.ct-fab') as HTMLElement).click());
    await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();
    await page.evaluate(() => new Promise<void>((r) => requestIdleCallback(() => r())));
  }
  await browser.startTracing(page, { path: 'tmp-trace.json', categories: ['devtools.timeline'] });
  await page.evaluate(async () => {
    const shown = new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    (document.querySelector('.ct-fab') as HTMLElement).click();
    await shown;
    await new Promise((r) => setTimeout(r, 600));
  });
  await browser.stopTracing();
  const raw = JSON.parse(readFileSync('tmp-trace.json', 'utf8'));
  const events = (raw.traceEvents ?? raw) as any[];
  const rows = events.filter((e) => e.ph === 'X' && e.dur && ['Layout', 'UpdateLayoutTree', 'Paint', 'EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'RunTask'].includes(e.name) && e.dur > 8000);
  rows.sort((a, b) => a.ts - b.ts);
  const t0 = rows[0]?.ts ?? 0;
  for (const e of rows) console.log(((e.ts - t0) / 1000).toFixed(0).padStart(5), 'ms +', (e.dur / 1000).toFixed(0).padStart(4), e.name, JSON.stringify(e.args?.beginData ?? e.args?.data ?? {}).slice(0, 110));
  rmSync('tmp-trace.json');
});
