import axios, { AxiosInstance } from 'axios';

/**
 * Dedicated axios instance for API Gateway
 * NO AUTHENTICATION - API Gateway does not require auth
 */

const apiGatewayAxios: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: parseInt(import.meta.env.VITE_API_TIMEOUT || '30000', 10),
  headers: {
    'Content-Type': 'application/json',
  },
});

console.log('[API GATEWAY AXIOS] Initialized without auth interceptors');
console.log('[API GATEWAY AXIOS] Base URL:', import.meta.env.VITE_API_BASE_URL);

export default apiGatewayAxios;
