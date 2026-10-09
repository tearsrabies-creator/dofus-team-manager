// Configuration d'ESLint, l'outil qui relit le code TypeScript à la recherche
// d'erreurs probables et de mauvaises pratiques (`npm run lint`).
//
// On part des règles recommandées de JavaScript et de typescript-eslint, dans
// leur version « typée » : elles utilisent les types de TypeScript pour
// repérer par exemple une promesse oubliée (un `invoke(...)` dont personne
// ne regarde l'échec éventuel).

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Fichiers à ne pas relire : code généré, compilé ou côté Rust.
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Laisse typescript-eslint trouver tsconfig.json tout seul.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Les fichiers de configuration (comme celui-ci) ne font pas partie du
  // projet TypeScript : on ne leur applique pas les règles typées.
  {
    files: ["*.config.js", "*.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
);
