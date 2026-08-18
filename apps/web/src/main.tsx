import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { DebugWorldPage } from './pages/DebugWorldPage.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

/**
 * Routing is one line on purpose: the app has exactly two entry points so far
 * and no router dependency is worth it yet. Wave 4 (WS-D) can swap this for a
 * real router without touching the world code.
 */
const path = window.location.pathname.replace(/\/+$/, '');
const page = path === '/debug/world' ? <DebugWorldPage /> : <App />;

createRoot(container).render(<StrictMode>{page}</StrictMode>);
