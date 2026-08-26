import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios';
import { msalInstance } from '@/auth/msalInstance';
import { tokenRequest } from '@config/authConfig';

// Track if MSAL is initialized
let msalInitialized = false;

// Wait for MSAL to be initialized
export const waitForMsalInitialization = async (): Promise<void> => {
  if (msalInitialized) return;
  
  // Wait for MSAL initialization with timeout
  const timeout = 10000; // 10 seconds
  const startTime = Date.now();
  
  while (!msalInitialized && (Date.now() - startTime) < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  if (!msalInitialized) {
    console.warn('[AXIOS] MSAL initialization timeout - proceeding without auth');
  }
};

// Call this from main.tsx after MSAL initialization
export const setMsalInitialized = () => {
  msalInitialized = true;
  console.log('[AXIOS] MSAL marked as initialized');
};

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];

// Create axios instance
const axiosInstance: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: parseInt(import.meta.env.VITE_API_TIMEOUT || '30000', 10),
  headers: {
    'Content-Type': 'application/json',
  },
});

// Retry delay with exponential backoff
const getRetryDelay = (retryCount: number): number => {
  return RETRY_DELAY * Math.pow(2, retryCount);
};

// Check if request should be retried
const shouldRetry = (error: AxiosError, retryCount: number): boolean => {
  if (retryCount >= MAX_RETRIES) return false;
  
  // Do NOT retry CORS errors
  if (!error.response && error.code === 'ERR_NETWORK') {
    console.warn('[AXIOS] Network error detected - not retrying (likely CORS)');
    return false;
  }
  
  // Do NOT retry 4xx client errors
  const status = error.response?.status;
  if (status && status >= 400 && status < 500) {
    return false;
  }
  
  // Only retry server errors
  if (status && RETRY_STATUS_CODES.includes(status)) return true;
  
  return false;
};

// Request interceptor to add authentication token
axiosInstance.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    // Initialize retry count
    if (!config.headers['X-Retry-Count']) {
      config.headers['X-Retry-Count'] = '0';
    }

    try {
      // Wait for MSAL to be initialized
      if (!msalInitialized) {
        console.log('[AXIOS] Waiting for MSAL initialization...');
        await waitForMsalInitialization();
      }

      const accounts = msalInstance.getAllAccounts();

      if (accounts.length > 0) {
        // Acquire token silently
        const response = await msalInstance.acquireTokenSilent({
          ...tokenRequest,
          account: accounts[0],
        });

        // Add token to request headers
        if (response.accessToken) {
          config.headers.Authorization = `Bearer ${response.accessToken}`;
        }
      } else {
        console.warn('[AXIOS] No accounts found - request will proceed without token');
      }
    } catch (error) {
      console.error('[AXIOS] Failed to acquire token:', error);
      // Token acquisition failed, request will proceed without token
      // The API will return 401 and the app should redirect to login
    }

    return config;
  },
  (error: unknown) => {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
);

// Response interceptor for error handling and retry logic
axiosInstance.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    if (!originalRequest) {
      return Promise.reject(error);
    }

    // Get current retry count
    const retryCount = parseInt(originalRequest.headers['X-Retry-Count'] as string || '0', 10);

    // Handle 401 Unauthorized errors
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      if (msalInitialized) {
        try {
          const accounts = msalInstance.getAllAccounts();

          if (accounts.length > 0) {
            // Try to acquire token again
            const response = await msalInstance.acquireTokenSilent({
              ...tokenRequest,
              account: accounts[0],
            });

            if (response.accessToken) {
              originalRequest.headers.Authorization = `Bearer ${response.accessToken}`;
              return axiosInstance(originalRequest);
            }
          }
        } catch (refreshError) {
          // Token refresh failed, redirect to login
          console.error('[AXIOS] Token refresh failed:', refreshError);
          return Promise.reject(
            refreshError instanceof Error ? refreshError : new Error(String(refreshError))
          );
        }
      }
    }

    // Retry logic for specific errors
    if (shouldRetry(error, retryCount)) {
      originalRequest.headers['X-Retry-Count'] = String(retryCount + 1);
      
      // Wait before retrying with exponential backoff
      await new Promise(resolve => setTimeout(resolve, getRetryDelay(retryCount)));
      
      console.log(`[AXIOS] Retrying request (${retryCount + 1}/${MAX_RETRIES}):`, originalRequest.url);
      return axiosInstance(originalRequest);
    }

    // Handle other errors
    if (error.response) {
      // Server responded with error status
      console.error('[AXIOS] API Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        url: originalRequest.url,
        method: originalRequest.method,
      });
    } else if (error.request) {
      // Request was made but no response received
      console.error('[AXIOS] Network Error (likely CORS or network issue):', {
        message: error.message,
        code: error.code,
        url: originalRequest.url,
        method: originalRequest.method,
      });
    } else {
      // Something else happened
      console.error('[AXIOS] Request Error:', error.message);
    }

    return Promise.reject(error);
  }
);

export default axiosInstance;
