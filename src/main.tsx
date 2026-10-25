import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/app.tsx';
import './ui/styles.css';

/*
 * The mount point.
 *
 * React 19's createRoot rather than hydrate, because this app is served as a
 * Static Asset with no server-rendered markup to attach to — the Worker returns
 * index.html and the shell renders in the browser from the session it fetches.
 */

const root = document.querySelector<HTMLElement>('#root');
if (root === null) {
  // A missing root is a broken document rather than an empty state, so it fails
  // loudly here instead of rendering nothing a user would have to diagnose.
  throw new Error('The app root element is missing from the document.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
