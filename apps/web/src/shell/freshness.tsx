import { ReactElement, ReactNode, createContext, useContext, useEffect, useState } from 'react';

const STALE_AFTER_MS = 3 * 5 * 60_000; // three missed 5-min polls

interface Freshness {
  lastPollAt: Date | null;
  secondsAgo: number | null;
  isStale: boolean;
}

const FreshnessContext = createContext<Freshness>({ lastPollAt: null, secondsAgo: null, isStale: false });

export function useFreshness(): Freshness {
  return useContext(FreshnessContext);
}

interface ProviderProps {
  updatedAt: string | null | undefined;
  children: ReactNode;
}

/** Staleness is a context concern — every metric surface reads it, none computes it. */
export function FreshnessProvider({ updatedAt, children }: ProviderProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const lastPollAt = updatedAt ? new Date(updatedAt) : null;
  const secondsAgo = lastPollAt ? Math.max(0, Math.round((now - lastPollAt.getTime()) / 1000)) : null;
  const isStale = lastPollAt !== null && now - lastPollAt.getTime() > STALE_AFTER_MS;

  return (
    <FreshnessContext.Provider value={{ lastPollAt, secondsAgo, isStale }}>
      {children}
    </FreshnessContext.Provider>
  );
}
