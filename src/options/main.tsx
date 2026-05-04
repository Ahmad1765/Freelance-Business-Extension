import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import Options from './Options';

const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><Options /></StrictMode>);
