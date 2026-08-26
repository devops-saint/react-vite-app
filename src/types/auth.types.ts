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
}
