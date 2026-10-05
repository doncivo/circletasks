import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../types';
import { epochId, publishedStateToJson, type DeviceAck, type PublishedDeviceState } from './format';
import { hasSafeJsonKeys, hlcDevice, hlcIso, hlcMs, journalRecordToText, parseJournalRecord, parsePublishedStateText, parseSnapshotRecord, publishedStateToText, snapshotRecordToText } from './parse';

/** Analyse stricte du texte clair (ADR 0011, sections 1.4, 3.1, 5.1 ; audit H5, M4 ; Y-02 critère 6). */

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const h = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const E1 = epochId(1, A);
const T1 = '11111111-1111-4111-8111-111111111111';

const record = (f: unknown, extra = ''): string => `{"k":"ops","sv":17,"ops":[{"t":"task","id":"${T1}","at":"2026-10-05T08:00:00.000Z","f":${JSON.stringify(f)}${extra}}]}`;

describe('enregistrement de journal', () => {
  it('aller-retour : les champs deviennent une Map, l’ordre est gardé', () => {
    const text = record({ title: ['Loyer', h(2), h(1)], note: ['', h(2), null] });
    const parsed = parseJournalRecord(text);
    expect(parsed?.ops[0]?.f).toBeInstanceOf(Map);
    expect([...(parsed?.ops[0]?.f.keys() ?? [])]).toEqual(['title', 'note']);
    expect(parsed && journalRecordToText(parsed)).toBe(text);
  });

  it.each([
    ['__proto__ dans les champs', record({ __proto__: ['x', h(1), null] }).replace('"f":{}', '"f":{"__proto__":["x","' + h(1) + '",null]}')],
    ['constructor', record({ constructor: ['x', h(1), null] })],
    ['prototype au premier niveau', '{"k":"ops","sv":17,"ops":[],"prototype":1}'],
    ['clé répétée (JSON.parse garderait la dernière)', record({ title: ['a', h(1), null] }).replace('"title"', '"title":["b","' + h(1) + '",null],"title"')],
    ['hlc mal formé', record({ title: ['a', '2026-10-05', null] })],
    ['hlc en majuscules', record({ title: ['a', h(1).toUpperCase(), null] })],
    ['base mal formée', record({ title: ['a', h(1), 'x'] })],
    ['clé en trop dans une opération', record({ title: ['a', h(1), null] }, ',"x":1')],
    ['nom de table en forme SQL', record({ title: ['a', h(1), null] }).replace('"t":"task"', '"t":"task; DROP TABLE task"')],
    ['valeur booléenne (JSON true)', record({ title: [true, h(1), null] })],
    ['aucun champ', record({})],
    ['sv nul', record({ title: ['a', h(1), null] }).replace('"sv":17', '"sv":0')],
  ])('refuse l’enregistrement entier : %s', (_label, text) => {
    expect(parseJournalRecord(text)).toBeNull();
  });

  it('hasSafeJsonKeys suit les chaînes et les échappements (une valeur n’imite pas une clé)', () => {
    expect(hasSafeJsonKeys('{"a":"\\"a\\":1","b":{"a":1}}')).toBe(true);
    expect(hasSafeJsonKeys('{"a":1,"a":2}')).toBe(false);
    expect(hasSafeJsonKeys('{"x":[{"__proto__":1}]}')).toBe(false);
    expect(hasSafeJsonKeys('{"\\u005f_proto__":1}')).toBe(false);
  });
});

describe('enregistrements d’instantané', () => {
  it('aller-retour des cinq formes ; horloge « * » obligatoire', () => {
    const covers = new Map<DeviceId, DeviceAck>([[B, { epoch: E1, segment: 1, record: 3, hlc: h(9, B), stateSeq: 4 }]]);
    const records = [
      { k: 'snap-rows', rows: [['task', new Map<string, string | number | null>([['id', T1], ['title', 'x']]), new Map([['*', h(1)]])]] },
      { k: 'snap-row', t: 'task', row: new Map<string, string | number | null>([['id', T1]]), clocks: new Map([['*', h(1)], ['title', h(2)]]) },
      { k: 'snap-unknown', fields: [{ t: 'task', id: T1, field: 'mood', value: 'ok', hlc: h(3), base: null, sv: 18 }] },
      { k: 'snap-tombstones', ids: [['task', T1, h(4)]] },
      { k: 'snap-end', count: 4, covers, epoch: E1, sv: 17 },
    ] as const;
    for (const r of records) {
      const text = snapshotRecordToText(r as never);
      expect(snapshotRecordToText(parseSnapshotRecord(text) as never)).toBe(text);
    }
    expect(parseSnapshotRecord('{"k":"snap-rows","rows":[["task",{"id":"x"},{"title":"' + h(1) + '"}]]}')).toBeNull();
    expect(parseSnapshotRecord('{"k":"snap-end","count":1,"covers":{"x":{}},"epoch":"' + E1 + '","sv":17}')).toBeNull();
    expect(parseSnapshotRecord('{"k":"autre"}')).toBeNull();
  });
});

describe('état publié (dette de l’amorce : forme lexicale de serde, ordre canonique)', () => {
  const ack: DeviceAck = { epoch: E1, segment: 1, record: 2, hlc: h(5), stateSeq: 3 };
  const state: PublishedDeviceState = {
    deviceId: A,
    platform: 'windows',
    appVersion: '0.4.0',
    sm: 1,
    sv: 17,
    epoch: E1,
    stateSeq: 3,
    head: ack,
    acks: new Map([[B, { ...ack, hlc: h(4, B), stateSeq: 7 }]]),
    snapshot: { seq: 1, endHlc: h(1) },
    purgeHorizon: null,
    lastSyncHlc: h(6),
    pairedBy: B,
    forgotten: [],
    reset: null,
  };

  it('le même état donne toujours le même texte, quel que soit l’ordre des clés de l’objet reçu', () => {
    const json = publishedStateToJson(state) as unknown as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(json).reverse());
    const text = JSON.stringify(reordered);
    const parsed = parsePublishedStateText(text);
    expect(parsed && publishedStateToText(parsed)).toBe(publishedStateToText(state));
    expect(publishedStateToText(state).startsWith('{"deviceId"')).toBe(true);
  });

  it('clé répétée, nombre non entier, clé interdite : refusés comme le ferait serde', () => {
    const text = publishedStateToText(state);
    expect(parsePublishedStateText(text)).not.toBeNull();
    expect(parsePublishedStateText(text.replace('"sm":1', '"sm":1,"sm":1'))).toBeNull();
    expect(parsePublishedStateText(text.replace('"sm":1', '"sm":1.0'))).toBeNull();
    expect(parsePublishedStateText(text.replace('"forgotten":[]', '"forgotten":[{"__proto__":1}]'))).toBeNull();
  });

  it('hlc : temps, appareil et instant ISO', () => {
    expect(hlcMs(h(1_791_187_200_000))).toBe(1_791_187_200_000);
    expect(hlcDevice(h(1, B))).toBe(B);
    expect(hlcIso(h(1_791_187_200_000))).toBe('2026-10-05T08:00:00.000Z');
  });
});
