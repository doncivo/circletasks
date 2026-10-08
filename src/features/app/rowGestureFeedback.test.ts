import { describe, expect, it } from 'vitest';
import { createFakeHaptics } from '../../platform/haptics';
import { rowGestureFeedback } from './rowGestureFeedback';

/** A-07 critère 14 : l'adaptateur traduit les cinq moments du geste en retours haptiques. */
describe('rowGestureFeedback (A-07)', () => {
  it('seuil : selection ; validation : impact medium ; succès : notification success ; ouverture et appui long : impact light', () => {
    const fake = createFakeHaptics();
    const feedback = rowGestureFeedback(fake);
    feedback.threshold();
    feedback.commit();
    feedback.succeeded();
    feedback.open();
    feedback.longPress();
    expect(fake.calls).toEqual([
      { type: 'selection' },
      { type: 'impact', style: 'medium' },
      { type: 'notification', kind: 'success' },
      { type: 'impact', style: 'light' },
      { type: 'impact', style: 'light' },
    ]);
  });
});
