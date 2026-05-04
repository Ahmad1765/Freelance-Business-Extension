import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import App from './App';

const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>);
