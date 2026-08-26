import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from '@/config/authConfig';

/**
 * MSAL Instance
 * Single instance of PublicClientApplication for the entire application.
 * Initialize outside of the root component to ensure it is not re-initialized on re-renders.
 * MSAL will handle initialization automatically when needed.
 */
export const msalInstance = new PublicClientApplication(msalConfig);
