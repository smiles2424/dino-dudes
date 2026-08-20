import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The phone's first load. `/` is the only route inside the 5 s promise, and the
 * dynamic imports in `src/main.tsx` and `src/capture/CapturePage.tsx` are what
 * actually keep three.js out of the entry chunk.
 *
 * `manualChunks` then pins three.js and React into their own long-lived files:
 * thirty phones hit the same host within a minute, and a redeploy between two
 * classes must not re-download 1 MB of renderer because a label changed.
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
