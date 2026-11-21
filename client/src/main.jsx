import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/global.css';
import App from './App.jsx';
import { takeBuildSiteLink } from './buildLink.js';

// /app/?buildSite=<id> from Growth OS: open that saved site in Build mode (buildLink.js)
takeBuildSiteLink();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
