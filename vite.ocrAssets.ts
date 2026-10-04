import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

/**
 * Repli OCR tesseract.js (Q-04 décision D3) : le worker, le noyau WebAssembly (SIMD, LSTM seul) et les données françaises (modèle
 * « best » quantifié) sont servis par l'app sous `/ocr/`, jamais téléchargés d'Internet. En développement, un intergiciel les lit dans
 * node_modules ; à la construction, ils sont copiés dans `dist/ocr/` (aucun binaire n'est versionné). Licences : docs/licences.md.
 */
const ROOT = import.meta.dirname;

/** URL publique -> fichier de node_modules. */
const ASSETS: Readonly<Record<string, { readonly file: string; readonly type: string }>> = {
  '/ocr/worker.min.js': { file: 'node_modules/tesseract.js/dist/worker.min.js', type: 'text/javascript' },
  '/ocr/tesseract-core-simd-lstm.wasm.js': { file: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', type: 'text/javascript' },
  '/ocr/lang/fra.traineddata.gz': { file: 'node_modules/@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz', type: 'application/gzip' },
};

export function ocrAssets(): Plugin {
  const serve = (url: string | undefined): { body: Buffer; type: string } | null => {
    const asset = ASSETS[(url ?? '').split('?')[0] ?? ''];
    const path = asset ? resolve(ROOT, asset.file) : null;
    return asset && path && existsSync(path) ? { body: readFileSync(path), type: asset.type } : null;
  };
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const found = serve(req.url);
    if (!found) return next();
    res.setHeader('Content-Type', found.type);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(found.body);
  };
  return {
    name: 'circletasks-ocr-assets',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
    generateBundle() {
      for (const [url, asset] of Object.entries(ASSETS)) {
        const path = resolve(ROOT, asset.file);
        if (!existsSync(path)) this.error(`Fichier du repli OCR introuvable : ${asset.file} (npm ci)`);
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(path) });
      }
    },
  };
}
