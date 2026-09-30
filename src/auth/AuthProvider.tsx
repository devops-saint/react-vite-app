import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useCallback,
} from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '@/config/authConfig';
import { User, UserRole, AuthContextType } from '@/types/auth.types';
import {
  NormalizedAccess,
  hasMarketAccess as hasMarketAccessUtil,
  hasEnvironmentAccess as hasEnvironmentAccessUtil,
} from '@/types/access.types';
import { EnvironmentName } from '@/types/request.types';
import { config } from '@/config';
import { accessService } from '@/api/services';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}


export function AuthProvider({ children }: AuthProviderProps) {
  const { instance, accounts, inProgress } = useMsal();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Real, server-sourced RBAC (idea #19) - see src/types/access.types.ts
  // and AuthContextType's own doc comment for the read-only fallback
  // behavior on 'error'.
  const [access, setAccess] = useState<NormalizedAccess | null>(null);
  const [accessStatus, setAccessStatus] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');

  // Safety timeout to prevent infinite loading
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (isLoading) {
        console.warn('[AuthProvider] Loading timeout reached, forcing loading state to false');
        setIsLoading(false);
      }
    }, 10000); // 10 second timeout

    return () => clearTimeout(timeout);
  }, [isLoading]);

  // Map MSAL account to User object
  useEffect(() => {
    console.log('[AuthProvider] State Update:', {
      inProgress,
      accountsLength: accounts.length,
      accounts: accounts.map(a => ({ username: a.username, name: a.name }))
    });

    if (inProgress === InteractionStatus.None && accounts.length > 0) {
      const account = accounts[0];
      if (account) {
        const mappedUser: User = {
          id: account.localAccountId || '',
          email: account.username || '',
          name: account.name || '',
          roles: extractRolesFromToken(account.idTokenClaims),
        };
        console.log('[AuthProvider] User authenticated:', mappedUser);
        setUser(mappedUser);
      }
      setIsLoading(false);
    } else if (inProgress === InteractionStatus.None) {
      console.log('[AuthProvider] No authenticated user');
      setUser(null);
      setIsLoading(false);
    }
  }, [accounts, inProgress]);

  // Look up real RBAC access (idea #19) for the signed-in user's email
  // once they're known. Runs once per distinct email - not on every
  // AuthProvider re-render - and resets to 'idle' on sign-out so a
  // subsequent sign-in (possibly as a different user) starts clean
  // rather than reusing stale access data.
  useEffect(() => {
    const email = user?.email;
    if (!email) {
      setAccess(null);
      setAccessStatus('idle');
      return;
    }

    let cancelled = false;
    setAccessStatus('loading');

    void (async () => {
      try {
        const result = await accessService.getAccess(email);
        if (!cancelled) {
          setAccess(result);
          setAccessStatus('loaded');
        }
      } catch (error) {
        console.error(
          `[AuthProvider] Failed to load RBAC access for ${email} - falling back to read-only:`,
          error
        );
        if (!cancelled) {
          setAccess(null);
          setAccessStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.email]);

  // Login function using redirect
  const login = useCallback(async () => {
    try {
      setError(null);
      await instance.loginRedirect(loginRequest);
      // Note: After redirect, the page will reload and user will be authenticated
    } catch (error) {
      console.error('Login failed:', error);
      setError('Login failed. Please try again.');
      throw error;
    }
  }, [instance]);

  // Logout function using redirect
  const logout = useCallback(async () => {
    try {
      await instance.logoutRedirect({
        postLogoutRedirectUri: window.location.origin + config.routes.login,
      });
      // Note: After redirect, the page will reload
    } catch (error) {
      console.error('Logout failed:', error);
      setError('Logout failed. Please try again.');
      throw error;
    }
  }, [instance]);

  // Check if user has a specific role. ADMIN reflects real, server-sourced
  // RBAC (access.role === 'admin' from the org's /access lambda, idea #19)
  // - this is what lets RequestDetailsPage's existing hasRole(ADMIN) gates
  // (recovery actions, PR links) work off real Azure AD-backed admin
  // status.
  const hasRole = useCallback(
    (role: UserRole): boolean => {
      if (role === UserRole.ADMIN && access?.role === 'admin') {
        return true;
      }
      return user?.roles.includes(role) || false;
    },
    [user, access]
  );

  // Check if user has any of the specified roles
  const hasAnyRole = useCallback(
    (roles: UserRole[]): boolean => {
      if (roles.includes(UserRole.ADMIN) && access?.role === 'admin') {
        return true;
      }
      return roles.some((role) => user?.roles.includes(role)) || false;
    },
    [user, access]
  );

  // Mutations (create/cancel a request, de-whitelist, admin actions) are
  // only allowed once real access data has actually loaded - not while
  // it's still loading, and not on 'error' (see AuthContextType's doc
  // comment: that's the "read-only" fallback).
  const canMutate = accessStatus === 'loaded';

  // Viewing is left unrestricted until access has positively loaded and
  // said otherwise, so pages never flash an artificially-empty market
  // list while the lookup is still in flight or has failed - only a
  // *confirmed* 'loaded' result actually narrows what's shown.
  const hasMarketAccess = useCallback(
    (marketCode: string): boolean => {
      if (accessStatus !== 'loaded') return true;
      return hasMarketAccessUtil(access, marketCode);
    },
    [access, accessStatus]
  );

  const hasEnvironmentAccess = useCallback(
    (marketCode: string, environment: EnvironmentName): boolean => {
      if (accessStatus !== 'loaded') return true;
      return hasEnvironmentAccessUtil(access, marketCode, environment);
    },
    [access, accessStatus]
  );

  const value: AuthContextType = {
    isAuthenticated: !!user,
    user,
    isLoading,
    error,
    login,
    logout,
    hasRole,
    hasAnyRole,
    access,
    accessStatus,
    canMutate,
    hasMarketAccess,
    hasEnvironmentAccess,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Hook to use auth context
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Helper function to extract roles from token claims
function extractRolesFromToken(claims: unknown): UserRole[] {
  // In a real implementation, extract roles from the token claims
  // For now, return default roles
  const claimsObj = claims as Record<string, unknown>;
  
  if (claimsObj && Array.isArray(claimsObj['roles'])) {
    return claimsObj['roles'].map((role: string) => {
      switch (role.toLowerCase()) {
        case 'admin':
          return UserRole.ADMIN;
        case 'approver':
          return UserRole.APPROVER;
        case 'viewer':
          return UserRole.VIEWER;
        default:
          return UserRole.USER;
      }
    });
  }

  // Default role
  return [UserRole.USER];
}
