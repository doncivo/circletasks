# Journal de développement CircleTasks

Ce journal compte une ligne par story livrée ou par décision notable : date, story concernée, fichiers touchés et décisions prises.

| Date | Story | Fichiers touchés | Décisions |
| --- | --- | --- | --- |
| 2026-10-01 | PREP-02 | .gitignore, .gitattributes, package.json, src/{domain,db,platform,i18n,ui,features}, src-tauri/, tests/, docs/adr/0001-0003 | Dépôt local main ; Tauri 2 + React 18 + TS strict ; contrat SqlDriver, driver tauri-plugin-sql et driver de dev @sqlite.org/sqlite-wasm (FTS5) ; migrations maison rejouables ; appels pendant une transaction mis en file avec délai 10 s ; i18n typé maison ; identifiant fr.circletasks.planner |
| 2026-10-01 | PREP-03 | docs/archive/README.md, docs/archive/comparaison-stories.md, docs/archive/PRD_CircleTasks_v4_Windows.md, docs/journal.md | PRD v3 et scaffold Expo absents du poste : seul le PRD v4 (circletasks-win) est archivé et comparé ; 2 stories absentes et 3 partielles signalées à Ali |
| 2026-10-02 | PREP-04 | src/ui/theme/{fonts,tokens}.css, src/ui/Icon.tsx, docs/licences.md, docs/adr/0001 | Polices @fontsource-variable (latin + latin-ext, ~182 Ko) ; lucide-react ; jetons PRD section 5, thème sombre d'après Main-Sombre.html |
