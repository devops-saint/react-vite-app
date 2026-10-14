import axios from 'axios';
import apiGatewayAxios from '../apiGatewayAxios';
import {
  CreateRequestFormData,
  ApiGatewayRequestPayload,
  ApiGatewaySuccessResponse,
  ApiGatewayErrorResponse,
  RequestedBy,
  RequestType,
} from '@/types/request.types';
import { v4 as uuidv4 } from 'uuid';

/**
 * API Gateway Service
 * Handles all communication with AWS API Gateway
 */

/**
 * Transform UI form data to API Gateway payload format
 */
export const transformToApiGatewayPayload = (
  formData: CreateRequestFormData,
  submittedBy: RequestedBy,
  requestType: RequestType = 'WHITELIST'
): ApiGatewayRequestPayload => {
  const payload: ApiGatewayRequestPayload = {
    request_id: `REQ-${uuidv4().substring(0, 8).toUpperCase()}`,
    market_code: formData.marketCode.toLowerCase(),
    market_name: formData.marketName,
    business_justification: formData.businessJustification,
    submitted_by: submittedBy,
    environments: {},
    // Omit for the ordinary/default case rather than always sending
    // 'WHITELIST', so an older backend deployment that doesn't know this
    // field yet sees an identical payload to before.
    ...(requestType !== 'WHITELIST' ? { request_type: requestType } : {}),
  };

  // Transform environments
  formData.environments.forEach((env) => {
    const envKey = env.environment.toLowerCase() as 'dev' | 'qa' | 'prd';

    payload.environments[envKey] = {
      // Extract bucket names from S3Bucket objects
      buckets: env.resources.s3Buckets.map((bucket) => bucket.bucketName),

      // Extract ARNs from SecretManager objects
      secrets: env.resources.secretsManager.map((secret) => secret.secretArn),

      // Extract ARNs from KMSKey objects
      kmsKeys: env.resources.kmsKeys.map((key) => key.keyArn),

      // Extract ARNs from LambdaFunction objects
      functions: env.resources.lambdaFunctions.map((func) => func.functionArn),
    };

    // COMBINED: resources.* above are the additions; the removals ride along
    // in a nested "remove" object (see update_yaml_data in lambda-gitops).
    if (requestType === 'COMBINED' && env.removals) {
      const remove = {
        buckets: env.removals.s3Buckets.map((bucket) => bucket.bucketName),
        secrets: env.removals.secretsManager.map((secret) => secret.secretArn),
        kmsKeys: env.removals.kmsKeys.map((key) => key.keyArn),
        functions: env.removals.lambdaFunctions.map((func) => func.functionArn),
      };
      (Object.keys(remove) as Array<keyof typeof remove>).forEach((section) => {
        if (remove[section].length === 0) delete remove[section];
      });
      if (Object.keys(remove).length > 0) {
        payload.environments[envKey].remove = remove;
      }
    }

    // Remove empty arrays to keep payload clean
    if (payload.environments[envKey]?.buckets?.length === 0) {
      delete payload.environments[envKey].buckets;
    }
    if (payload.environments[envKey]?.secrets?.length === 0) {
      delete payload.environments[envKey].secrets;
    }
    if (payload.environments[envKey]?.kmsKeys?.length === 0) {
      delete payload.environments[envKey].kmsKeys;
    }
    if (payload.environments[envKey]?.functions?.length === 0) {
      delete payload.environments[envKey].functions;
    }
  });

  return payload;
};

/**
 * Submit request to API Gateway
 */
export const submitRequest = async (
  formData: CreateRequestFormData,
  submittedBy: RequestedBy,
  requestType: RequestType = 'WHITELIST'
): Promise<ApiGatewaySuccessResponse> => {
  try {
    // Transform form data to API Gateway format
    const payload = transformToApiGatewayPayload(formData, submittedBy, requestType);

    console.log('[API GATEWAY] Submitting request to API Gateway');
    console.log(
      '[API GATEWAY] API Base URL:',
      import.meta.env.VITE_API_BASE_URL
    );
    console.log('[API GATEWAY] Endpoint: POST /request');
    console.log('[API GATEWAY] Payload:', JSON.stringify(payload, null, 2));

    // Submit to API Gateway (NO AUTH)
    const response = await apiGatewayAxios.post<ApiGatewaySuccessResponse>(
      '/request',
      payload
    );

    console.log(
      '[API GATEWAY] Response received:',
      response.status,
      response.statusText
    );
    console.log('[API GATEWAY] Response data:', response.data);

    return response.data;
  } catch (error) {
    console.error('[API GATEWAY] Request failed:', error);

    // Handle API Gateway errors
    if (axios.isAxiosError(error) && error.response) {
      const errorResponse = error.response.data as ApiGatewayErrorResponse;
      console.error('[API GATEWAY] Error response:', errorResponse);
      throw new Error(
        errorResponse.message ||
          `API Gateway Error: ${error.response.status} - ${error.response.statusText}`
      );
    }

    // Handle network or other errors
    throw new Error(
      error instanceof Error
        ? error.message
        : 'Failed to submit request to API Gateway'
    );
  }
};

/**
 * API Gateway Service object
 */
export const apiGatewayService = {
  submitRequest,
  transformToApiGatewayPayload,
};
