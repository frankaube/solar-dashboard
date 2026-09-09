import { ReactElement, ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ThemeMode, buildTheme, initialThemeMode, setThemeMode } from '../theme';

interface Mode {
  mode: ThemeMode;
  toggle: () => void;
}

const ThemeModeContext = createContext<Mode>({ mode: 'dark', toggle: () => undefined });

export function useThemeMode(): Mode {
  return useContext(ThemeModeContext);
}

/**
 * Holds which palette is live, and swaps it before anything renders against it.
 *
 * `setThemeMode` is called in the lazy initialiser and inside the setter, never from an
 * effect: effects run after paint, so the first frame would use the wrong palette.
 */
export function ThemeModeProvider({ children }: { children: ReactNode }): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const initial = initialThemeMode();
    setThemeMode(initial);
    return initial;
  });

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      setThemeMode(next);
      return next;
    });
  }, []);

  const theme = useMemo(() => buildTheme(mode), [mode]);
  const value = useMemo(() => ({ mode, toggle }), [mode, toggle]);

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}
