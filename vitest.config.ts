import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // next/font/local only exists inside the Next compiler; pages that load
      // a scoped font (e.g. /design/console) get the stub's identical shape.
      'next/font/local': path.resolve(__dirname, 'tests', 'stubs', 'next-font-local.ts'),
      '@': path.resolve(__dirname, '.'),
    },
  },
  // Pages/components use the automatic JSX runtime (no `import React`), same as
  // Next builds them — without this, importing a *.tsx page throws
  // "React is not defined" under the classic runtime.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Hermetic creds: .env.local is a live credential store read fresh at call
    // time (lib/creds.ts), so tests must never see the operator's real file. Tests
    // that exercise the store point this at their own tmp path.
    env: {
      GLADOS_ENV_LOCAL: path.resolve(__dirname, 'tests', '.env.local.does-not-exist'),
      // Hermetic data dir: the operator's Filming switch (.glados-mode) must never point
      // a test run at demo-data/. Tests that exercise the switch set their own file.
      GLADOS_MODE_FILE: path.resolve(__dirname, 'tests', '.glados-mode.does-not-exist'),
      // A fresh clone defaults to the demo company (lib/paths.ts); tests see the
      // blank install unless they opt in.
      GLADOS_DEFAULT_MODE: 'real',
      // The Creative Engine on-disk rename (lib/creative-engine/migrate.ts) must
      // never move the operator's data/ad-engine or public/content-media/ad-engine
      // during a test run: old dirs are read in place. Migration tests opt in
      // with their own temp dirs.
      CREATIVE_ENGINE_MIGRATE: '0',
      // Never let a local Ollama on the dev box change which LLM provider tests see.
      OLLAMA_DISABLED: '1',
      GROQ_API_KEY: '',
    },
  },
});
