import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

/**
 * Routing is a lookup table on purpose: three entry points, and no router
 * dependency is worth it yet.
 *
 * Both 3D routes are `lazy()` because `/` is the page a child opens on school
 * Wi-Fi and the only one inside the 5 s promise, while three.js and
 * @react-three are ~1 MB. Together with the lazy `PreviewStage` inside
 * `CapturePage`, the phone downloads the renderer while the child is typing
 * their name rather than before the first paint.
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
