import { Configuration, LogLevel } from '@azure/msal-browser';

// Debug: Log environment variables (remove in production)
console.log('[AUTH CONFIG] Environment Variables:', {
  CLIENT_ID: import.meta.env.VITE_CLIENT_ID ? '✓ Present' : '✗ Missing',
  TENANT_ID: import.meta.env.VITE_TENANT_ID ? '✓ Present' : '✗ Missing',
  REDIRECT_URI: import.meta.env.VITE_REDIRECT_URI || 'Using default',
});

export const msalConfig: Configuration = {
  auth: {
    clientId: import.meta.env.VITE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_TENANT_ID}`,
    redirectUri: import.meta.env.VITE_REDIRECT_URI,
    postLogoutRedirectUri: import.meta.env.VITE_REDIRECT_URI,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) {
          return;
        }
        switch (level) {
          case LogLevel.Error:
            console.error('[MSAL]', message);
            return;
          case LogLevel.Info:
            console.info('[MSAL]', message);
            return;
          case LogLevel.Verbose:
            console.debug('[MSAL]', message);
            return;
          case LogLevel.Warning:
            console.warn('[MSAL]', message);
            return;
          default:
            return;
        }
      },
    },
  },
};

// Debug: Log MSAL config (remove in production)
console.log('[AUTH CONFIG] MSAL Configuration:', {
  clientId: msalConfig.auth?.clientId ? '✓ Configured' : '✗ Missing',
  authority: msalConfig.auth?.authority,
  redirectUri: msalConfig.auth?.redirectUri,
});

export const loginRequest = {
  scopes: ['User.Read'],
};

export const tokenRequest = {
  scopes: ['User.Read'],
};
