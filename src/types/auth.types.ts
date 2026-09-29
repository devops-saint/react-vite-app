import { NormalizedAccess } from './access.types';
import { EnvironmentName } from './request.types';

export interface User {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
  department?: string;
  jobTitle?: string;
}

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
  APPROVER = 'approver',
  VIEWER = 'viewer',
}

export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  isLoading: boolean;
  error: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthContextType extends AuthState {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
  hasAnyRole: (roles: UserRole[]) => boolean;
  // Temporary stand-in for real Azure AD ADMIN app-role assignment
  // (see the audit doc's auth-gap finding) - lets someone who knows a
  // build-time code (VITE_ADMIN_ACCESS_CODE) unlock ADMIN-gated UI for
  // this browser tab. NOT a real security boundary: the code is baked
  // into the public JS bundle, and this only toggles which buttons
  // render client-side - it grants nothing on the (still unauthenticated)
  // backend. Remove once real AD role assignment is wired up.
  isAdminUnlocked: boolean;
  unlockAdminAccess: (code: string) => boolean;
  lockAdminAccess: () => void;

  // Real, server-sourced RBAC (idea #19) from the org's separate /access
  // lambda - see src/types/access.types.ts and src/api/services/accessService.ts.
  // `accessStatus` is 'loading' while the lookup for the signed-in
  // user's email is in flight, 'loaded' once real access data has come
  // back, and 'error' if the lookup failed or the response was
  // malformed. On 'error' the app falls back to READ-ONLY: viewing is
  // left unrestricted (hasMarketAccess/hasEnvironmentAccess both return
  // true) so nothing looks artificially empty, but `canMutate` is false,
  // so creating/cancelling requests, de-whitelisting, and admin actions
  // all stay blocked until access can actually be confirmed.
  access: NormalizedAccess | null;
  accessStatus: 'idle' | 'loading' | 'loaded' | 'error';
  canMutate: boolean;
  hasMarketAccess: (marketCode: string) => boolean;
  hasEnvironmentAccess: (marketCode: string, environment: EnvironmentName) => boolean;
}
