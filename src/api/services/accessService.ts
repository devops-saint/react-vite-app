import apiGatewayAxios from '../apiGatewayAxios';
import { normalizeAccess, NormalizedAccess } from '@/types/access.types';

/**
 * Client for the org's separate RBAC lambda (not part of this repo) -
 * GET /access?email=... on the same API Gateway, returning who this user
 * is and which markets/environments they can act on. See
 * src/types/access.types.ts for the exact wire format and how it's
 * normalized.
 */
export const accessService = {
  async getAccess(email: string): Promise<NormalizedAccess> {
    const response = await apiGatewayAxios.get<unknown>('/access', {
      params: { email },
    });

    // Some Lambda proxy responses come back without an explicit
    // application/json Content-Type header, in which case axios leaves
    // the body as a raw string instead of parsing it - handle both.
    const data: unknown =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

    // Tolerate either the documented { email, access } envelope or a
    // bare access object, in case the route ever changes shape.
    const accessRaw: unknown =
      data && typeof data === 'object' && 'access' in data
        ? (data).access
        : data;

    return normalizeAccess(accessRaw);
  },
};
