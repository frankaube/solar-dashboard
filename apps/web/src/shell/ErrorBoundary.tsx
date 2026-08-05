import { Component, ErrorInfo, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { solar } from '../theme';

interface State {
  error: Error | null;
}

/**
 * Without this, any render throw white-screens the whole dashboard — a single bad field
 * from the DTU could take down a page that is otherwise fine. Show what broke and keep a
 * route back, rather than a blank document.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the detail in the console for a bug report; the UI stays plain-language.
    console.error('Dashboard render failed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: 'background.default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 6,
        }}
      >
        <Box
          sx={{
            maxWidth: 560,
            bgcolor: solar.surface.card,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: `${solar.radius.card}px`,
            p: 7,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <Typography variant="answer" component="h2" sx={{ color: 'text.primary' }}>
            Something on this page broke.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Your data is safe — this is a display problem, and the collector keeps recording in the
            background. Reloading usually clears it.
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 3,
              bgcolor: solar.surface.inset,
              borderRadius: `${solar.radius.control}px`,
              font: `400 11px/1.5 ${solar.font.mono}`,
              color: solar.ink.dim,
              overflowX: 'auto',
            }}
          >
            {error.message}
          </Box>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button variant="contained" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button variant="outlined" onClick={() => { window.location.href = '/'; }}>
              Back to Home
            </Button>
          </Box>
        </Box>
      </Box>
    );
  }
}
