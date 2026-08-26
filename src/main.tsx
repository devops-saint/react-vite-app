import React from 'react';
import ReactDOM from 'react-dom/client';
import { MsalProvider } from '@azure/msal-react';
import { EventType, EventMessage, AuthenticationResult } from '@azure/msal-browser';
import { msalInstance } from '@/auth';
import { setMsalInitialized } from '@/api/axiosInstance';
import App from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to find the root element');
}

/**
 * MSAL should be initialized outside the root component and wrap the entire app.
 * This is critical for proper redirect handling.
 */

// MSAL v3 requires explicit initialization
void msalInstance.initialize().then(() => {
  console.log('[MSAL] Instance initialized');
  
  // Signal axios that MSAL is ready
  setMsalInitialized();

  // Register event callbacks for MSAL v3
  msalInstance.addEventCallback((event: EventMessage) => {
    console.log('[MSAL Event]', event.eventType, event);
    
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload) {
      console.log('[MSAL] Login success, setting active account');
      const payload = event.payload as AuthenticationResult;
      if (payload.account) {
        msalInstance.setActiveAccount(payload.account);
      }
    }
  });

  // Handle redirect promise
  msalInstance.handleRedirectPromise()
    .then((response) => {
      if (response) {
        console.log('[MSAL] Redirect response received:', {
          account: response.account?.username,
          scopes: response.scopes
        });
        if (response.account) {
          msalInstance.setActiveAccount(response.account);
        }
      } else {
        console.log('[MSAL] No redirect response');
        // Check if there's an active account in cache
        const accounts = msalInstance.getAllAccounts();
        if (accounts.length > 0) {
          console.log('[MSAL] Found cached accounts:', accounts.length);
          const account = accounts[0];
          if (account) {
            msalInstance.setActiveAccount(account);
          }
        }
      }
    })
    .catch((error) => {
      console.error('[MSAL] Redirect error:', error);
    });

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>
  );
});
