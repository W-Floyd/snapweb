import { defineConfig } from 'vite'
import { resolve } from 'path'

// Standalone library build — produces dist-lib/snap-client.{es,umd}.js
//   and dist-lib/snapclient.js (IIFE, for direct <script> embedding).
// Run with: npm run build:lib
// The default `vite build` (index.html → dist/) is unaffected.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/lib.ts'),
      name: 'SnapClient',
      formats: ['es', 'umd', 'iife'],
      fileName: (format) => format === 'iife' ? 'snapclient.js' : `snap-client.${format}.js`,
    },
    outDir: 'dist-lib',
    emptyOutDir: true,
  },
})
