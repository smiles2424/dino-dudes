import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

/**
 * Routing is a lookup table on purpose: the app has three entry points and no
 * router dependency is worth it yet. Chunk 4.2 can swap this for a real router
 * without touching the world code.
 *
 *   /             landing page (the capture flow; join links are `/?lobby=CODE`)
 *   /play         the live game view / projector screen (`?lobby=CODE`)
 *   /debug/world  the offline world harness — E2E #2 depends on it
 *
 * **Chunk 5.3 — code splitting.** `/` is the page a child opens on a phone on
 * school Wi-Fi, and it is the only one whose load time is in the 5 s promise.
 * three.js + @react-three are ~1 MB of that bundle, so both 3D routes are
 * `lazy()` here and the capture flow's own 3D step (`PreviewStage`) is lazy
 * inside `CapturePage` — the phone downloads the renderer *while the child is
 * typing their name and photographing the sheet*, not before the first paint.
 * The route split is what keeps the eager entry chunk small; the prefetch in
 * `CapturePage` is what keeps the preview instant anyway.
 */
const PlayPage = lazy(async () => ({ default: (await import('./pages/PlayPage.js')).PlayPage }));
const DebugWorldPage = lazy(async () => ({
  default: (await import('./pages/DebugWorldPage.js')).DebugWorldPage,
}));

const path = window.location.pathname.replace(/\/+$/, '');
const page =
  path === '/debug/world' ? <DebugWorldPage /> : path === '/play' ? <PlayPage /> : <App />;

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<RouteFallback />}>{page}</Suspense>
  </StrictMode>,
);

/**
 * Deliberately plain: no testid, no layout of its own. Every E2E assertion on
 * these routes waits for the real surface (`window.__world`, `lobby-status`),
 * so this must never look like one.
 */
function RouteFallback(): JSX.Element {
  return (
    <main className="app">
      <p className="processing" role="status">
        Loading the world…
      </p>
    </main>
  );
}
