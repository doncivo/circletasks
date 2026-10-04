import { describe, expect, it } from 'vitest';
import { findNode, findNodes, parseXml, textOf } from './xml';

describe('analyse XML (réponses WebDAV)', () => {
  const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!-- commentaire -->
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/1/calendars/a/</D:href>
    <D:propstat><D:prop><D:displayname>Dîner &amp; Cie &lt;3 &#233;&#x41;</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:calendar-data><![CDATA[BEGIN:VCALENDAR
SUMMARY:a & b < c
END:VCALENDAR]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <response><href>/2/</href></response>
</D:multistatus>`;

  it('ignore les préfixes, décode les entités et lit le CDATA tel quel', () => {
    const root = parseXml(DOC);
    expect(root?.name).toBe('multistatus');
    const responses = findNodes(root as NonNullable<typeof root>, 'response');
    expect(responses).toHaveLength(2);
    const first = responses[0] as NonNullable<(typeof responses)[number]>;
    expect(textOf(first, 'href')).toBe('/1/calendars/a/');
    expect(textOf(first, 'displayname')).toBe('Dîner & Cie <3 éA');
    expect(textOf(first, 'calendar-data')).toContain('SUMMARY:a & b < c');
    expect(findNode(first, 'resourcetype')?.children.map((child) => child.name)).toEqual(['collection', 'calendar']);
    expect(textOf(responses[1] as NonNullable<(typeof responses)[number]>, 'href')).toBe('/2/');
  });

  it('lit les attributs entre guillemets simples ou doubles', () => {
    const root = parseXml(`<c:supported xmlns:c="urn:x"><c:comp name="VEVENT"/><c:comp name='VTODO'></c:comp></c:supported>`);
    expect(findNodes(root as NonNullable<typeof root>, 'comp').map((node) => node.attributes['name'])).toEqual(['VEVENT', 'VTODO']);
  });

  it('refuse un document mal formé, vide ou à deux racines', () => {
    expect(parseXml('')).toBeNull();
    expect(parseXml('<a><b></a>')).toBeNull();
    expect(parseXml('<a>')).toBeNull();
    expect(parseXml('<a/><b/>')).toBeNull();
    expect(parseXml('texte')).toBeNull();
  });

  it('ne développe ni entité externe ni DTD', () => {
    const root = parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>');
    expect(root?.text).toBe('&x;');
  });
});
