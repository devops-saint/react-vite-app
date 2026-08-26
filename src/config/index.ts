import type { MarketOption } from '@/types/request.types';

// Bundled fallback list, used when VITE_AVAILABLE_MARKETS is unset or empty.
const DEFAULT_MARKETS: MarketOption[] = [
  { code: 'UK', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PL', name: 'Poland' },
  { code: 'CZ', name: 'Czech Republic' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'IE', name: 'Ireland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
];

// Parses "CODE:Name,CODE:Name,..." (VITE_AVAILABLE_MARKETS) into MarketOption[].
// Falls back to DEFAULT_MARKETS when the env var is unset, empty, or unparseable.
function parseMarkets(raw: string | undefined): MarketOption[] {
  if (!raw || !raw.trim()) {
    return DEFAULT_MARKETS;
  }

  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, ...nameParts] = entry.split(':');
      return {
        code: (code || '').trim(),
        name: nameParts.join(':').trim(),
      };
    })
    .filter((market) => market.code && market.name);

  return parsed.length > 0 ? parsed : DEFAULT_MARKETS;
}

export const config = {
  // Microsoft Entra ID Configuration
  auth: {
    clientId: import.meta.env.VITE_CLIENT_ID || '',
    tenantId: import.meta.env.VITE_TENANT_ID || '',
    redirectUri: import.meta.env.VITE_REDIRECT_URI || 'http://localhost:3000',
  },

  // API Configuration
  api: {
    baseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api',
    timeout: Number(import.meta.env.VITE_API_TIMEOUT) || 30000,
  },

  // Application Configuration
  app: {
    name: import.meta.env.VITE_APP_NAME || 'AWS Self-Service Whitelisting Portal',
    version: import.meta.env.VITE_APP_VERSION || '1.0.0',
    environment: import.meta.env.VITE_ENVIRONMENT || 'development',
  },

  // AWS Configuration
  aws: {
    repositoryName: import.meta.env['VITE_REPOSITORY_NAME'] || 'aws-whitelist-config',
    region: import.meta.env['VITE_AWS_REGION'] || 'eu-west-1',
  },

  // Feature Flags
  features: {
    enableDevtools: import.meta.env.VITE_ENABLE_DEVTOOLS === 'true',
  },

  // Available Markets (comma-separated "CODE:Name" pairs in VITE_AVAILABLE_MARKETS)
  markets: parseMarkets(import.meta.env.VITE_AVAILABLE_MARKETS),

  // Client-side Route Paths
  routes: {
    home: import.meta.env.VITE_ROUTE_HOME || '/',
    login: import.meta.env.VITE_ROUTE_LOGIN || '/login',
    dashboard: import.meta.env.VITE_ROUTE_DASHBOARD || '/dashboard',
    requests: import.meta.env.VITE_ROUTE_REQUESTS || '/requests',
    requestsCreate: import.meta.env.VITE_ROUTE_REQUESTS_CREATE || '/requests/create',
    requestDetails: import.meta.env.VITE_ROUTE_REQUEST_DETAILS || '/requests/:id',
    help: import.meta.env.VITE_ROUTE_HELP || '/help',
    notFound: import.meta.env.VITE_ROUTE_NOT_FOUND || '/404',
    profile: import.meta.env.VITE_ROUTE_PROFILE || '/profile',
    settings: import.meta.env.VITE_ROUTE_SETTINGS || '/settings',
  },
} as const;

/**
 * Builds the request-details route for a specific request id, e.g.
 * buildRequestDetailsPath('123') -> '/requests/123' (path template comes
 * from VITE_ROUTE_REQUEST_DETAILS / config.routes.requestDetails).
 */
export const buildRequestDetailsPath = (requestId: string): string =>
  config.routes.requestDetails.replace(':id', requestId);
