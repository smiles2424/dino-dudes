import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Chunk 5.3 — the phone's first load.
 *
 * `/` is opened by a child on school Wi-Fi and is the only route inside the 5 s
 * promise. The 3D routes (`/play`, `/debug/world`) and the capture flow's own
 * preview step are dynamic imports (see `src/main.tsx` / `src/capture/CapturePage.tsx`),
 * which is what actually keeps three.js out of the entry chunk.
 *
 * `manualChunks` then does one further thing that matters at a venue: it pins
 * three.js and React into their **own long-lived files**. Thirty phones hit the
 * same static host within a minute of each other, and a redeploy between two
 * classes must not re-download 1 MB of renderer just because a button label
 * changed — the vendor hashes only move when the dependency does.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    // `three` (~843 kB minified) is the only chunk allowed near this, and it is
    // never on the phone's critical path. Anything else crossing it is a
    // regression worth shouting about.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          // Vite's `__vitePreload` helper is shared by the entry and every
          // dynamic import, and Rollup is happy to park it *inside* the three
          // chunk — which makes the entry statically import 844 kB and puts a
          // `modulepreload` for it in index.html. Give it its own file.
          if (id.includes('vite/preload-helper')) return 'preload';
          if (!id.includes('node_modules')) return undefined;
          // Only the renderer itself. Anything shared with the eager entry
          // (scheduler, the reconciler's react dependency) must stay where
          // Rollup puts it — naming it here would drag this chunk eager.
          if (/[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id)) return 'three';
          if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
