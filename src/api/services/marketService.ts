import apiGatewayAxios from '../apiGatewayAxios';

/**
 * Markets live in the config repo as one folder per market code. The
 * backend reads that folder list (GET /markets) and, for admins, onboards a
 * new market by opening pull requests that add its folder (POST /markets).
 */
export interface OnboardedPullRequest {
  /** Branch the PR targets: dev, qa or master. */
  branch: string;
  prUrl: string;
  filesCreated: string[];
}

export interface OnboardMarketResult {
  marketCode: string;
  pullRequests: OnboardedPullRequest[];
  /** Branches that already had the market and so got no PR. */
  alreadyPresentOn: string[];
}

// Some Lambda proxy responses come back without an explicit
// application/json Content-Type, in which case axios leaves the body as a
// raw string instead of parsing it - handle both (same as qnaService).
function unwrap(data: unknown): unknown {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parsePullRequest(value: unknown): OnboardedPullRequest | null {
  const pr = asRecord(value);
  const branch = pr['branch'];
  if (typeof branch !== 'string' || !branch) return null;
  const url = pr['prUrl'];
  return {
    branch,
    // Only ever rendered as a link, so accept http(s) and nothing else.
    prUrl: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '',
    filesCreated: stringList(pr['filesCreated']),
  };
}

export const marketService = {
  /** Upper-case market codes found in the config repo. */
  async getMarkets(): Promise<string[]> {
    const response = await apiGatewayAxios.get<unknown>('/markets');
    const markets = asRecord(unwrap(response.data))['markets'];
    return [...new Set(stringList(markets).map((code) => code.trim().toUpperCase()))]
      .filter(Boolean)
      .sort();
  },

  /** Admin only. `email` is the signed-in admin; the backend re-checks it. */
  async onboardMarket(marketCode: string, email: string): Promise<OnboardMarketResult> {
    const response = await apiGatewayAxios.post<unknown>('/markets', {
      market_code: marketCode,
      email,
    });
    const data = asRecord(unwrap(response.data));
    const pullRequests = Array.isArray(data['pullRequests'])
      ? data['pullRequests']
          .map(parsePullRequest)
          .filter((pr): pr is OnboardedPullRequest => pr !== null)
      : [];
    const code = data['marketCode'];
    return {
      marketCode: typeof code === 'string' && code ? code : marketCode.toUpperCase(),
      pullRequests,
      alreadyPresentOn: stringList(data['alreadyPresentOn']),
    };
  },
};
