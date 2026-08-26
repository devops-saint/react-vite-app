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

export function AuthProvider({ children }: AuthProviderProps) {
  const { instance, accounts, inProgress } = useMsal();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Check if user has a specific role
  const hasRole = useCallback(
    (role: UserRole): boolean => {
      return user?.roles.includes(role) || false;
    },
    [user]
  );

  // Check if user has any of the specified roles
  const hasAnyRole = useCallback(
    (roles: UserRole[]): boolean => {
      return roles.some((role) => user?.roles.includes(role)) || false;
    },
    [user]
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
