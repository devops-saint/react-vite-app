import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '@/config';
import { marketService } from '@/api/services';
import type { MarketOption } from '@/types/request.types';

/**
 * The market list, read from the config repo (one folder per market code)
 * through the backend. Replaces the static VITE_AVAILABLE_MARKETS list,
 * which is now used only for display names and as a fallback when the
 * repository can't be reached.
 */

const FRESH_FOR_MS = 60_000;

let cached: { markets: MarketOption[]; at: number } | null = null;
let inflight: Promise<MarketOption[]> | null = null;

/** Name for a market code: the configured name, else the country for a
 * two-letter ISO code (DE -> Germany), else the code itself. */
function displayName(code: string): string {
  const configured = config.markets.find((item) => item.code.toUpperCase() === code);
  if (configured) return configured.name;
  if (/^[A-Z]{2}$/.test(code)) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
      if (name && name !== code && !/unknown/i.test(name)) return name;
    } catch {
      // Unsupported runtime or code - fall through to the plain code.
    }
  }
  return code;
}

function toOptions(codes: string[]): MarketOption[] {
  return codes.map((code) => ({ code, name: displayName(code) }));
}

/** Drops the cached list so the next load re-reads the repository. */
export function invalidateMarketsCache(): void {
  cached = null;
}

async function loadMarkets(force: boolean): Promise<{ markets: MarketOption[]; fallback: boolean }> {
  if (!force && cached && Date.now() - cached.at < FRESH_FOR_MS) {
    return { markets: cached.markets, fallback: false };
  }
  try {
    inflight ??= marketService.getMarkets().then(toOptions);
    const markets = await inflight;
    cached = { markets, at: Date.now() };
    return { markets, fallback: false };
  } catch (error) {
    console.error('[MARKETS] Could not load markets from the repository:', error);
    // Not cached, so the next page visit tries the repository again.
    return { markets: config.markets, fallback: true };
  } finally {
    inflight = null;
  }
}

export interface UseMarketsResult {
  markets: MarketOption[];
  loading: boolean;
  /** True when the repository couldn't be read and the configured list is shown. */
  fallback: boolean;
  reload: () => void;
}

export function useMarkets(): UseMarketsResult {
  const [state, setState] = useState<{ markets: MarketOption[]; loading: boolean; fallback: boolean }>(
    () => ({ markets: cached?.markets ?? [], loading: cached === null, fallback: false })
  );
  const mounted = useRef(true);

  const load = useCallback((force: boolean) => {
    setState((previous) => ({ ...previous, loading: true }));
    void loadMarkets(force).then((result) => {
      if (mounted.current) setState({ ...result, loading: false });
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(false);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);

  return { ...state, reload };
}
