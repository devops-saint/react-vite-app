import { EnvironmentName } from './request.types';

/**
 * Real, server-sourced RBAC (idea #19 - RBAC-Gated Create Request),
 * fetched from a separate org lambda (GET /access?email=...) that is not
 * part of this repo. Its wire format is deliberately asymmetric between
 * roles - confirmed from real examples:
 *
 *   admin: { "role": "admin", "markets": ["ALL"], "environments": ["ALL"] }
 *   user:  { "role": "user", "markets": { "UY": ["DEV", "PRD", "QAS"] } }
 *
 * Notably: admin's markets/environments are single-element ["ALL"]
 * arrays (not the bare string "ALL"), a user has no top-level
 * "environments" key at all (environments are nested per-market), and
 * the org's own environment code for QA is "QAS", not this portal's
 * "QA" - see ENV_ALIASES below. normalizeAccess() below absorbs all of
 * that into one consistent shape the rest of the app can use.
 */
export interface NormalizedAccess {
  role: 'admin' | 'user';
  // 'ALL' = unrestricted access to every market and environment.
  // Otherwise: exactly which environments this user may act on, per
  // market code (market codes are stored upper-cased; compare
  // case-insensitively via hasMarketAccess/hasEnvironmentAccess below
  // rather than indexing this map directly).
  markets: 'ALL' | Record<string, EnvironmentName[]>;
}

// The org's RBAC lambda uses its own environment codes, which don't
// always match this portal's EnvironmentName ('DEV' | 'QA' | 'PRD') -
// e.g. "QAS" instead of "QA". Extend this map if the lambda starts
// returning other aliases; an unrecognized code is dropped (logged via
// console.warn in normalizeAccess) rather than silently mismatched,
// since granting access to a made-up environment name would be a no-op
// everywhere else in the app anyway.
const ENV_ALIASES: Record<string, EnvironmentName> = {
  DEV: 'DEV',
  DEVELOPMENT: 'DEV',
  QA: 'QA',
  QAS: 'QA',
  QUALITY: 'QA',
  PRD: 'PRD',
  PROD: 'PRD',
  PRODUCTION: 'PRD',
};

function normalizeEnvironmentCode(raw: string): EnvironmentName | null {
  const mapped = ENV_ALIASES[raw.trim().toUpperCase()];
  if (!mapped) {
    console.warn(
      `[access] Unrecognized environment code from the RBAC lambda: "${raw}" - ignoring it (add it to ENV_ALIASES in access.types.ts if this is a real environment).`
    );
    return null;
  }
  return mapped;
}

/**
 * Parses the raw `access` object from GET /access into NormalizedAccess.
 * Throws on a shape that doesn't match either known role, so a caller
 * (accessService) can treat that the same as a network failure - the
 * fallback behavior when access can't be determined is "read-only",
 * handled by AuthProvider, not by guessing a shape here.
 */
export function normalizeAccess(raw: unknown): NormalizedAccess {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed access response: expected an object.');
  }
  const obj = raw as Record<string, unknown>;

  if (obj['role'] === 'admin') {
    return { role: 'admin', markets: 'ALL' };
  }

  if (obj['role'] === 'user') {
    const marketsRaw = obj['markets'];
    const markets: Record<string, EnvironmentName[]> = {};
    if (marketsRaw && typeof marketsRaw === 'object' && !Array.isArray(marketsRaw)) {
      for (const [marketCode, envsRaw] of Object.entries(
        marketsRaw as Record<string, unknown>
      )) {
        if (!Array.isArray(envsRaw)) continue;
        const envs = envsRaw
          .filter((env): env is string => typeof env === 'string')
          .map(normalizeEnvironmentCode)
          .filter((env): env is EnvironmentName => env !== null);
        markets[marketCode.toUpperCase()] = envs;
      }
    }
    return { role: 'user', markets };
  }

  throw new Error(`Malformed access response: unrecognized role "${String(obj['role'])}".`);
}

export function hasMarketAccess(
  access: NormalizedAccess | null,
  marketCode: string
): boolean {
  if (!access) return false;
  if (access.markets === 'ALL') return true;
  return Object.prototype.hasOwnProperty.call(access.markets, marketCode.toUpperCase());
}

export function hasEnvironmentAccess(
  access: NormalizedAccess | null,
  marketCode: string,
  environment: EnvironmentName
): boolean {
  if (!access) return false;
  if (access.markets === 'ALL') return true;
  const envs = access.markets[marketCode.toUpperCase()];
  return Boolean(envs?.includes(environment));
}
