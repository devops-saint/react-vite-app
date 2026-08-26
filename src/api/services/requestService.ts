import {
  WhitelistRequest,
  RequestDetails,
  CreateRequestFormData,
  ListRequestsResponse,
  BackendRequest,
  Environment,
  EnvironmentName,
  RequestedBy,
} from '@/types/request.types';
import { config } from '@/config';
import { v4 as uuidv4 } from 'uuid';
import { apiGatewayService } from './apiGatewayService';
import axios from 'axios';
import apiGatewayAxios from '../apiGatewayAxios';

/**
 * Request Service
 * Handles all API calls related to whitelist requests
 */

/**
 * Parse backend environments format to frontend format
 */
const parseEnvironments = (envs: unknown): Environment[] => {
  if (!envs || typeof envs !== 'object') return [];

  const result: Environment[] = [];

  for (const [envName, resources] of Object.entries(
    envs as Record<string, unknown>
  )) {
    const envKey = envName.toUpperCase() as EnvironmentName;
    if (['DEV', 'QA', 'PRD'].includes(envKey)) {
      const resourceObj = resources as Record<string, unknown>;
      result.push({
        environment: envKey,
        resources: {
          s3Buckets: ((resourceObj['buckets'] as string[]) || []).map(
            (name: string) => ({ bucketName: name })
          ),
          secretsManager: ((resourceObj['secrets'] as string[]) || []).map(
            (arn: string) => ({ secretArn: arn })
          ),
          kmsKeys: ((resourceObj['kmsKeys'] as string[]) || []).map(
            (arn: string) => ({ keyArn: arn })
          ),
          lambdaFunctions: ((resourceObj['functions'] as string[]) || []).map(
            (arn: string) => ({ functionArn: arn })
          ),
        },
      });
    }
  }

  return result;
};

/**
 * Transform backend request object to frontend format
 * Handles field name conversion from snake_case to camelCase
 */
const transformBackendRequest = (
  backendRequest: BackendRequest
): WhitelistRequest => {
  console.log(
    '[REQUEST SERVICE] Transforming backend request:',
    backendRequest
  );

  const payload = backendRequest.payload || {};

  // Use payload.request_id (human-readable REQ-xxx) if available, fallback to root request_id (UUID)
  const requestId = payload.request_id || backendRequest.request_id;
  console.log(
    '[REQUEST SERVICE] Using requestId:',
    requestId,
    'from payload.request_id:',
    payload.request_id,
    'or root request_id:',
    backendRequest.request_id
  );

  return {
    requestId, // Use human-readable ID for routing
    marketCode: payload.market_code || 'UNKNOWN',
    marketName: payload.market_name || 'Unknown Market',
    repositoryName: payload.repository_name || 'aws-whitelist-config',
    businessJustification: payload.business_justification || '',
    requestedBy: {
      id: payload.submitted_by?.id || '',
      name: payload.submitted_by?.name || 'Backend User',
      email: payload.submitted_by?.email || 'user@backend.com',
    },
    aws: { region: payload.aws_region || 'eu-west-1' },
    environments: parseEnvironments(payload.environments),
    status: backendRequest.status as WhitelistRequest['status'],
    createdAt: backendRequest.createdAt,
    updatedAt: backendRequest.createdAt, // Backend doesn't provide updatedAt
  };
};

export const requestService = {
  /**
   * Create a new whitelist request
   */
  createRequest: async (
    data: CreateRequestFormData,
    submittedBy: RequestedBy
  ): Promise<WhitelistRequest> => {
    console.log('[REQUEST SERVICE] createRequest called', {
      apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
      marketCode: data.marketCode,
    });

    try {
      console.log('[REQUEST SERVICE] Submitting to API Gateway...');

      // Submit to API Gateway
      const apiResponse = await apiGatewayService.submitRequest(
        data,
        submittedBy
      );

      console.log('[REQUEST SERVICE] API Gateway response:', apiResponse);

      // Create local request object for UI
      const newRequest: WhitelistRequest = {
        requestId:
          apiResponse.requestId ||
          `REQ-${uuidv4().substring(0, 8).toUpperCase()}`,
        marketCode: data.marketCode,
        marketName: data.marketName,
        repositoryName: config.aws.repositoryName,
        businessJustification: data.businessJustification,
        requestedBy: submittedBy,
        aws: { region: config.aws.region },
        environments: data.environments,
        status: 'SUBMITTED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return newRequest;
    } catch (error) {
      console.error('[REQUEST SERVICE] API Gateway error:', error);
      // Re-throw with enhanced error message
      throw new Error(
        error instanceof Error
          ? error.message
          : 'Failed to submit request to API Gateway'
      );
    }
  },

  /**
   * Get all requests for the current user
   */
  getAllRequests: async (userId: string): Promise<WhitelistRequest[]> => {
    console.log('[REQUEST SERVICE] getAllRequests called', {
      apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
    });

    try {
      console.log('[REQUEST SERVICE] Fetching from GET /listrequests...');
      const response = await apiGatewayAxios.get<ListRequestsResponse>(
        '/listrequests',
        { params: { userId } }
      );
      console.log(
        '[REQUEST SERVICE] GET /listrequests response:',
        response.data
      );

      // Extract requests array from the response object
      const backendRequests = response.data?.requests ?? [];
      console.log(
        '[REQUEST SERVICE] Extracted',
        backendRequests.length,
        'requests from response'
      );

      // Transform backend requests to frontend format
      const requests = (backendRequests as unknown as BackendRequest[]).map(
        transformBackendRequest
      );
      console.log('[REQUEST SERVICE] Transformed requests:', requests);

      return requests;
    } catch (error) {
      console.error('[REQUEST SERVICE] GET /listrequests error:', error);
      throw new Error(
        error instanceof Error
          ? `Failed to fetch requests: ${error.message}`
          : 'Failed to fetch requests'
      );
    }
  },

  /**
   * Get a single request by ID
   */
  getRequestById: async (
    requestId: string,
    userId: string
  ): Promise<RequestDetails | null> => {
    console.log('[REQUEST SERVICE] getRequestById called', {
      requestId,
    });

    try {
      console.log(`[REQUEST SERVICE] Fetching GET /requests/${requestId}...`);

      // Try to get from backend detail endpoint
      const response = await apiGatewayAxios.get<RequestDetails>(
        `/requests/${requestId}`,
        { params: { userId } }
      );
      console.log(
        '[REQUEST SERVICE] GET /requests/:id response:',
        response.data
      );

      // Backend might return raw format, need to check and transform if needed
      return response.data;
    } catch (error) {
      console.error('[REQUEST SERVICE] GET /requests/:id error:', error);

      // If detail endpoint fails, try to get from list and find by ID
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(
          '[REQUEST SERVICE] Detail endpoint not found, falling back to list lookup...'
        );
        try {
          const allRequests = await requestService.getAllRequests(userId);
          const found = allRequests.find((r) => r.requestId === requestId);

          if (found) {
            console.log('[REQUEST SERVICE] Found request in list:', found);
            // Convert WhitelistRequest to RequestDetails by adding empty history/comments
            const details: RequestDetails = {
              ...found,
              history: [
                {
                  status: found.status,
                  timestamp: found.createdAt,
                  performedBy: found.requestedBy.name,
                },
              ],
              comments: [],
            };
            return details;
          }

          console.log('[REQUEST SERVICE] Request not found in list');
          return null;
        } catch (listError) {
          console.error(
            '[REQUEST SERVICE] Failed to fetch from list:',
            listError
          );
          return null;
        }
      }

      throw new Error(
        error instanceof Error
          ? `Failed to fetch request: ${error.message}`
          : 'Failed to fetch request'
      );
    }
  },

  /**
   * Get dashboard statistics
   */
  getDashboardStats: async (userId: string) => {
    console.log('[REQUEST SERVICE] getDashboardStats called');

    try {
      console.log('[REQUEST SERVICE] Fetching dashboard stats from backend...');
      const response = await apiGatewayAxios.get<ListRequestsResponse>(
        '/listrequests',
        { params: { userId } }
      );

      // Extract requests array from the response object
      const backendRequests = response.data?.requests ?? [];
      console.log(
        '[REQUEST SERVICE] Received',
        backendRequests.length,
        'backend requests'
      );

      // Transform backend requests to frontend format
      const requests = (backendRequests as unknown as BackendRequest[]).map(
        transformBackendRequest
      );
      console.log(
        '[REQUEST SERVICE] Calculating stats from',
        requests.length,
        'requests'
      );

      const stats = {
        pending: requests.filter(
          (r) =>
            r.status === 'SUBMITTED' ||
            r.status === 'BRANCH_CREATED' ||
            r.status === 'PULL_REQUEST_CREATED' ||
            r.status === 'PENDING_APPROVAL' ||
            r.status === 'REQUEST_RECEIVED' // Include backend status
        ).length,
        approved: requests.filter((r) => r.status === 'MERGED').length,
        rejected: requests.filter((r) => r.status === 'REJECTED').length,
        completed: requests.filter((r) => r.status === 'COMPLETED').length,
      };

      console.log('[REQUEST SERVICE] Dashboard stats:', stats);
      return stats;
    } catch (error) {
      console.error('[REQUEST SERVICE] Dashboard stats error:', error);
      throw new Error(
        error instanceof Error
          ? `Failed to fetch dashboard stats: ${error.message}`
          : 'Failed to fetch dashboard stats'
      );
    }
  },

  /**
   * Get recent requests (last 5)
   */
  getRecentRequests: async (userId: string): Promise<WhitelistRequest[]> => {
    console.log('[REQUEST SERVICE] getRecentRequests called');

    try {
      console.log('[REQUEST SERVICE] Fetching recent requests from backend...');
      const response = await apiGatewayAxios.get<ListRequestsResponse>(
        '/listrequests',
        { params: { userId } }
      );

      // Extract requests array from the response object
      const backendRequests = response.data?.requests ?? [];
      console.log(
        '[REQUEST SERVICE] Received',
        backendRequests.length,
        'backend requests'
      );

      // Transform backend requests to frontend format
      const requests = (backendRequests as unknown as BackendRequest[]).map(
        transformBackendRequest
      );
      console.log('[REQUEST SERVICE] Transformed', requests.length, 'requests');

      const recentRequests = [...requests]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
        .slice(0, 5);

      console.log(
        '[REQUEST SERVICE] Returning',
        recentRequests.length,
        'recent requests'
      );
      return recentRequests;
    } catch (error) {
      console.error('[REQUEST SERVICE] Recent requests error:', error);
      throw new Error(
        error instanceof Error
          ? `Failed to fetch recent requests: ${error.message}`
          : 'Failed to fetch recent requests'
      );
    }
  },

  /**
   * Download request as JSON
   */
  downloadRequestJson: (request: WhitelistRequest | RequestDetails): void => {
    const json = JSON.stringify(request, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `request-${request.requestId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};
