import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './shell/ErrorBoundary';
import { ThemeModeProvider } from './shell/ThemeMode';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Owns the MUI ThemeProvider and CssBaseline, because both depend on the mode. */}
      <ThemeModeProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ThemeModeProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
