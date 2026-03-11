import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/setup.ts', 'src/coach.ts', 'src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'build',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
