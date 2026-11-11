import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build`         -> dist/ (normal static site)
// `npm run build:single`  -> gerber-films.html, everything inlined, opens straight from disk
export default defineConfig(({ mode }) =>
  mode === 'single'
    ? { base: './', plugins: [viteSingleFile()], build: { outDir: 'dist-single' } }
    : { base: './' },
)
