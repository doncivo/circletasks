/**
 * Analyse XML minimale pour les réponses WebDAV / CalDAV (207 Multi-Status) : écrite à la main parce que `DOMParser` n'existe pas
 * dans Node (Vitest) et que les réponses de serveur sont du XML bien formé. Insensible aux préfixes d'espaces de noms (`d:href`,
 * `D:href`, `href` : même nom local). Pas de DTD, pas d'entités externes : seules les cinq entités standard et les références
 * numériques sont décodées, donc aucune attaque par entité n'est possible.
 */

export interface XmlNode {
  /** Nom local, sans préfixe, en minuscules. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  /** Texte direct du nœud (CDATA compris), mis bout à bout. */
  text: string;
}

const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const localName = (qualified: string): string => (qualified.includes(':') ? (qualified.split(':').pop() ?? qualified) : qualified).toLowerCase();

/** Arbre XML d'un document ; null si le document n'a pas de racine ou si les balises ne s'emboîtent pas. */
export function parseXml(source: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  for (const match of source.matchAll(TOKEN)) {
    const [, cdata, closing, tag, rawAttributes, selfClosing, text] = match;
    if (cdata !== undefined) {
      const top = stack[stack.length - 1];
      if (top) top.text += cdata;
    } else if (tag !== undefined) {
      if (closing === '/') {
        const top = stack.pop();
        if (!top || top.name !== localName(tag)) return null;
      } else {
        const attributes: Record<string, string> = {};
        for (const attribute of (rawAttributes ?? '').matchAll(ATTRIBUTE)) attributes[localName(attribute[1] ?? '')] = decodeEntities(attribute[2] ?? attribute[3] ?? '');
        const node: XmlNode = { name: localName(tag), attributes, children: [], text: '' };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        else if (root === null) root = node;
        else return null;
        if (selfClosing !== '/') stack.push(node);
      }
    } else if (text !== undefined) {
      const top = stack[stack.length - 1];
      if (top) top.text += decodeEntities(text);
    }
  }
  return stack.length === 0 ? root : null;
}

/** Premier descendant de ce nom local (parcours en profondeur, ordre du document), ou null. */
export function findNode(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deeper = findNode(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/** Tous les descendants de ce nom local, sans descendre dans un nœud déjà retenu. */
export function findNodes(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) found.push(child);
    else found.push(...findNodes(child, name));
  }
  return found;
}

/** Texte nettoyé du premier descendant de ce nom, ou null s'il n'existe pas. */
export function textOf(node: XmlNode, name: string): string | null {
  const found = findNode(node, name);
  return found ? found.text.trim() : null;
}
