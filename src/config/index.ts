import type { MarketOption } from '@/types/request.types';

export interface DocumentationLink {
  label: string;
  url: string;
}

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

// Parses "Label:URL,Label:URL,..." (VITE_DOCUMENTATION_LINKS) into
// DocumentationLink[]. The URL itself may contain colons (https://...), so
// only the first colon splits label from URL. Returns [] (no links
// section rendered) when unset, empty, or unparseable - the disclaimer
// text itself still renders regardless.
function parseDocumentationLinks(raw: string | undefined): DocumentationLink[] {
  if (!raw || !raw.trim()) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex === -1) return null;
      return {
        label: entry.slice(0, separatorIndex).trim(),
        url: entry.slice(separatorIndex + 1).trim(),
      };
    })
    .filter((link): link is DocumentationLink => Boolean(link && link.label && link.url));
}


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
    // AWS account ID per environment (DEV/QA/PRD each typically has its own
    // account) - one .env var per environment, kept as plain, individually
    // settable values rather than a packed/parsed string. Used by
    // buildAgentRoleArn() below; an environment left unset means that ARN
    // can't be computed and callers should show nothing rather than a
    // broken ARN.
    accountIds: {
      DEV: import.meta.env['VITE_AWS_ACCOUNT_ID_DEV'] || '',
      QA: import.meta.env['VITE_AWS_ACCOUNT_ID_QA'] || '',
      PRD: import.meta.env['VITE_AWS_ACCOUNT_ID_PRD'] || '',
    } as Record<string, string>,
  },

  // Cross-account policy preview (see buildPolicyPreview in
  // src/utils/policyPreview.ts). These are NOT read from the real
  // terraform module that defines the agent role's actual policy - that
  // module isn't part of this repo (only the portal's own Lambda roles
  // are, in terraform-org/main.tf) - so this is a representative,
  // standard-AWS-pattern action list per resource type, purely to give
  // requesters a sense of what they're granting before/after submitting.
  // Swap these for the real template once it's available, via .env -
  // nothing else needs to change.
  policyTemplates: {
    s3: (import.meta.env['VITE_POLICY_TEMPLATE_S3'] || 's3:GetObject,s3:ListBucket')
      .split(',').map((a) => a.trim()).filter(Boolean),
    secretsManager: (import.meta.env['VITE_POLICY_TEMPLATE_SECRETS'] || 'secretsmanager:GetSecretValue,secretsmanager:DescribeSecret')
      .split(',').map((a) => a.trim()).filter(Boolean),
    kmsKeys: (import.meta.env['VITE_POLICY_TEMPLATE_KMS'] || 'kms:Decrypt,kms:DescribeKey')
      .split(',').map((a) => a.trim()).filter(Boolean),
    lambdaFunctions: (import.meta.env['VITE_POLICY_TEMPLATE_LAMBDA'] || 'lambda:InvokeFunction')
      .split(',').map((a) => a.trim()).filter(Boolean),
  },

  // Feature Flags
  features: {
    enableDevtools: import.meta.env.VITE_ENABLE_DEVTOOLS === 'true',
  },

  // Available Markets (comma-separated "CODE:Name" pairs in VITE_AVAILABLE_MARKETS)
  markets: parseMarkets(import.meta.env.VITE_AVAILABLE_MARKETS),

  // Persistent integration-scope disclaimer shown on every page (see
  // IntegrationDisclaimer component) - portal-side whitelisting may only
  // be one part of the overall integration process, and the linked docs
  // are where the rest of that process lives. Both the message and the
  // links are environment-driven so they can be updated (or the whole
  // thing disabled) per-deployment without a code change.
  integrationDisclaimer: {
    enabled: import.meta.env.VITE_SHOW_INTEGRATION_DISCLAIMER !== 'false',
    message:
      import.meta.env.VITE_INTEGRATION_DISCLAIMER_TEXT ||
      'Whitelisting through this portal may only be one part of the overall integration process. Additional client-side configuration may also be required.',
    // Comma-separated "Label:URL" pairs, e.g.
    // "Integration Guide:https://docs.example.com/integration,Runbook:https://docs.example.com/runbook"
    links: parseDocumentationLinks(import.meta.env.VITE_DOCUMENTATION_LINKS),
  },

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
    whitelist: import.meta.env.VITE_ROUTE_WHITELIST || '/whitelist',
  },
} as const;

/**
 * Builds the request-details route for a specific request id, e.g.
 * buildRequestDetailsPath('123') -> '/requests/123' (path template comes
 * from VITE_ROUTE_REQUEST_DETAILS / config.routes.requestDetails).
 */
export const buildRequestDetailsPath = (requestId: string): string =>
  config.routes.requestDetails.replace(':id', requestId);

/**
 * Builds the Matillion agent IAM role ARN a client needs to configure
 * their side of the integration, e.g.
 * buildAgentRoleArn('DEV', 'UK') ->
 *   'arn:aws:iam::123456789012:role/matillion-dpc-dev-agent-uk-irsa'
 * Mirrors the terraform module's own naming
 * (matillion-dpc-${var.environment}-agent-${market_code}-irsa) and the
 * lower-casing the app already applies to environment/market when they're
 * used as resource identifiers elsewhere (see requestService.getCurrentWhitelist).
 * Returns null when VITE_AWS_ACCOUNT_ID isn't configured, since the ARN
 * would otherwise render with an empty account id segment.
 */
export const buildAgentRoleArn = (environment: string, marketCode: string): string | null => {
  const accountId = config.aws.accountIds[environment.toUpperCase()];
  if (!accountId) return null;
  return `arn:aws:iam::${accountId}:role/matillion-dpc-${environment.toLowerCase()}-agent-${marketCode.toLowerCase()}-irsa`;
};
