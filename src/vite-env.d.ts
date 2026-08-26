/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
  readonly VITE_CLIENT_ID: string;
  readonly VITE_TENANT_ID: string;
  readonly VITE_REDIRECT_URI: string;
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_TIMEOUT: string;
  readonly VITE_APP_NAME: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_ENVIRONMENT: string;
  readonly VITE_ENABLE_DEVTOOLS: string;
  readonly VITE_ROUTE_HOME: string;
  readonly VITE_ROUTE_LOGIN: string;
  readonly VITE_ROUTE_DASHBOARD: string;
  readonly VITE_ROUTE_REQUESTS: string;
  readonly VITE_ROUTE_REQUESTS_CREATE: string;
  readonly VITE_ROUTE_REQUEST_DETAILS: string;
  readonly VITE_ROUTE_HELP: string;
  readonly VITE_ROUTE_NOT_FOUND: string;
  readonly VITE_ROUTE_PROFILE: string;
  readonly VITE_ROUTE_SETTINGS: string;
  readonly VITE_AVAILABLE_MARKETS: string;
  readonly VITE_REPOSITORY_NAME: string;
  readonly VITE_AWS_REGION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
