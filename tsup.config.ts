import {defineConfig} from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx', 'src/web/server.ts'],
  format: 'esm',
  target: 'node18',
  clean: true,
  banner: {js: '#!/usr/bin/env node'},
})
