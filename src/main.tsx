import React from 'react';
import { createRoot } from 'react-dom/client';
import { CctvFirstApp } from './CctvFirstApp';
import './style.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><CctvFirstApp /></React.StrictMode>);
