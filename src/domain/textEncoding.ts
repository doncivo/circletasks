/**
 * Décodage d'un fichier texte venu de l'extérieur (import CSV, P-07). Pur : `TextDecoder` existe dans Node, WebView2 et WKWebView.
 *
 * - BOM UTF-16 (FF FE : petit-boutiste, FE FF : gros-boutiste) : décodé en UTF-16 (Excel « Unicode ») ;
 * - sinon UTF-8, avec ou sans BOM ; si l'UTF-8 est invalide, repli sur Windows-1252 (Excel français) ;
 * - un BOM UTF-8 est toujours retiré, y compris avant le repli (jamais de « ï»¿ » dans le premier en-tête).
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}
