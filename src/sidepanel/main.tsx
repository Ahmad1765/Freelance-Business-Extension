import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import SidePanelApp from './SidePanelApp';

const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><SidePanelApp /></StrictMode>);
