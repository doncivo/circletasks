// Lecture d'un Info.plist au format XML (plist 1.0), sans dépendance.
// Le Info.plist d'une IPA est binaire : la CI le convertit d'abord par `plutil -convert xml1`.
// Types : dict, array, string, integer, real, true, false, date (chaîne ISO), data (base64 conservé en chaîne).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    if (name in ENTITIES) return ENTITIES[name];
    throw new Error(`Entité XML inconnue : ${whole}`);
  });
}

/** Découpe le XML en balises et textes ; prologue, DOCTYPE et commentaires ignorés. */
function tokenize(xml) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(xml)) !== null) {
    if (m.index !== consumed) throw new Error(`XML illisible à la position ${consumed}`);
    consumed = re.lastIndex;
    if (m[2]) tokens.push({ kind: m[1] ? 'close' : m[4] ? 'empty' : 'open', name: m[2] });
    else if (m[5] !== undefined) tokens.push({ kind: 'text', text: m[5] });
  }
  if (consumed !== xml.length) throw new Error(`XML illisible à la position ${consumed}`);
  return tokens;
}

/** Analyse le texte d'un plist XML et rend sa valeur racine (en général un objet). */
export function parsePlist(xml) {
  const tokens = tokenize(xml);
  let i = 0;
  const skipBlank = () => {
    while (i < tokens.length && tokens[i].kind === 'text' && tokens[i].text.trim() === '') i += 1;
  };
  const expect = (kind, name) => {
    skipBlank();
    const t = tokens[i];
    if (!t || t.kind !== kind || t.name !== name) {
      throw new Error(`Plist : <${kind === 'close' ? '/' : ''}${name}> attendu, trouvé ${t ? `${t.kind} ${t.name ?? JSON.stringify(t.text)}` : 'fin'}`);
    }
    i += 1;
  };
  const readText = (name) => {
    let text = '';
    while (tokens[i] && tokens[i].kind === 'text') {
      text += tokens[i].text;
      i += 1;
    }
    expect('close', name);
    return decodeEntities(text);
  };
  const value = () => {
    skipBlank();
    const t = tokens[i];
    if (!t || (t.kind !== 'open' && t.kind !== 'empty')) throw new Error('Plist : valeur attendue');
    i += 1;
    const empty = t.kind === 'empty';
    switch (t.name) {
      case 'true':
      case 'false':
        if (!empty) expect('close', t.name);
        return t.name === 'true';
      case 'string':
      case 'date':
        return empty ? '' : readText(t.name);
      case 'data':
        return empty ? '' : readText(t.name).replace(/\s+/g, '');
      case 'integer':
      case 'real': {
        const raw = empty ? '' : readText(t.name).trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) throw new Error(`Plist : nombre invalide « ${raw} »`);
        return n;
      }
      case 'array': {
        const out = [];
        if (empty) return out;
        for (;;) {
          skipBlank();
          if (tokens[i]?.kind === 'close' && tokens[i].name === 'array') {
            i += 1;
            return out;
          }
          out.push(value());
        }
      }
      case 'dict': {
        const out = {};
        if (empty) return out;
        for (;;) {
          skipBlank();
          if (tokens[i]?.kind === 'close' && tokens[i].name === 'dict') {
            i += 1;
            return out;
          }
          expect('open', 'key');
          const key = readText('key');
          if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`Plist : clé en double « ${key} »`);
          out[key] = value();
        }
      }
      default:
        throw new Error(`Plist : type inconnu <${t.name}>`);
    }
  };
  expect('open', 'plist');
  const root = value();
  expect('close', 'plist');
  skipBlank();
  if (i !== tokens.length) throw new Error('Plist : contenu après </plist>');
  return root;
}
