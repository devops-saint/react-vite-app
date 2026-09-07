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
import { config } from '@/config';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

const ADMIN_UNLOCK_STORAGE_KEY = 'dpc_admin_unlocked';

export function AuthProvider({ children }: AuthProviderProps) {
  const { instance, accounts, inProgress } = useMsal();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Temporary admin-unlock state (see AuthContextType.isAdminUnlocked) -
  // sessionStorage-scoped so it clears when the tab closes rather than
  // lingering indefinitely on a shared machine. Read lazily since
  // sessionStorage isn't available during SSR/build.
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(ADMIN_UNLOCK_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

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

  // Check if user has a specific role. ADMIN is special-cased: the
  // temporary manual unlock (see isAdminUnlocked above) stands in for a
  // real Azure AD ADMIN app-role assignment until that's wired up.
  const hasRole = useCallback(
    (role: UserRole): boolean => {
      if (role === UserRole.ADMIN && isAdminUnlocked) {
        return true;
      }
      return user?.roles.includes(role) || false;
    },
    [user, isAdminUnlocked]
  );

  // Check if user has any of the specified roles
  const hasAnyRole = useCallback(
    (roles: UserRole[]): boolean => {
      if (roles.includes(UserRole.ADMIN) && isAdminUnlocked) {
        return true;
      }
      return roles.some((role) => user?.roles.includes(role)) || false;
    },
    [user, isAdminUnlocked]
  );

  // Unlock ADMIN-gated UI for this tab by matching the build-time
  // VITE_ADMIN_ACCESS_CODE. Returns false (and changes nothing) if the
  // code is empty (feature disabled) or doesn't match. See the caveats
  // on config.adminAccessCode and AuthContextType.isAdminUnlocked - this
  // is a client-side convenience, not real access control.
  const unlockAdminAccess = useCallback((code: string): boolean => {
    if (!config.adminAccessCode || code !== config.adminAccessCode) {
      return false;
    }
    setIsAdminUnlocked(true);
    try {
      sessionStorage.setItem(ADMIN_UNLOCK_STORAGE_KEY, 'true');
    } catch {
      // sessionStorage unavailable (private mode, etc.) - the in-memory
      // state still unlocks for the rest of this tab's session.
    }
    return true;
  }, []);

  const lockAdminAccess = useCallback(() => {
    setIsAdminUnlocked(false);
    try {
      sessionStorage.removeItem(ADMIN_UNLOCK_STORAGE_KEY);
    } catch {
      // no-op - nothing persisted to clean up
    }
  }, []);

  const value: AuthContextType = {
    isAuthenticated: !!user,
    user,
    isLoading,
    error,
    login,
    logout,
    hasRole,
    hasAnyRole,
    isAdminUnlocked,
    unlockAdminAccess,
    lockAdminAccess,
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
