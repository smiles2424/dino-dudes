import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DebugWorldPage } from './pages/DebugWorldPage.js';
import { PlayPage } from './pages/PlayPage.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

/**
 * Routing is a lookup table on purpose: the app has three entry points and no
 * router dependency is worth it yet. Chunk 4.2 can swap this for a real router
 * without touching the world code.
 *
 *   /             landing page (Chunk 4.2 turns this into the capture flow;
 *                 lobby join links are `/?lobby=CODE`)
 *   /play         the live game view / projector screen (`?lobby=CODE`)
 *   /debug/world  the offline world harness — E2E #2 depends on it
 */
const path = window.location.pathname.replace(/\/+$/, '');
const page =
  path === '/debug/world' ? <DebugWorldPage /> : path === '/play' ? <PlayPage /> : <App />;

createRoot(container).render(<StrictMode>{page}</StrictMode>);
