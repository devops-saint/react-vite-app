import apiGatewayAxios from '../apiGatewayAxios';

/**
 * Text of the Confluence pages the backend reads with its service account
 * (GET /troubleshoot/confluence). The browser can't open those pages
 * itself - they need a login - so the Troubleshooting page searches this
 * text instead of only the title/keywords from the .env file.
 */
export interface ConfluencePageContent {
  url: string;
  title: string;
  text: string;
}

// Some Lambda proxy responses come back without an explicit
// application/json Content-Type, in which case axios leaves the body as a
// raw string instead of parsing it - handle both (same as qnaService).
function unwrap(data: unknown): unknown {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

function isPage(value: unknown): value is ConfluencePageContent {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  const url = page['url'];
  return (
    typeof url === 'string' &&
    /^https?:\/\//i.test(url) &&
    typeof page['title'] === 'string' &&
    typeof page['text'] === 'string'
  );
}

export const knowledgeService = {
  /** Empty when the backend has no Confluence access configured. */
  async getConfluencePages(): Promise<ConfluencePageContent[]> {
    const response = await apiGatewayAxios.get<unknown>('/troubleshoot/confluence');
    const data = unwrap(response.data);
    const pages =
      data && typeof data === 'object' ? (data as { pages?: unknown }).pages : undefined;
    return Array.isArray(pages) ? pages.filter(isPage) : [];
  },
};
