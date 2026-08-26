// API Response wrapper
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
}

// Paginated response
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// API Error response
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  timestamp: string;
}

// Request status
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';

// Whitelist entry
export interface WhitelistEntry {
  id: string;
  ipAddress: string;
  description: string;
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  expiresAt?: string;
  status: RequestStatus;
  region: string;
  environment: 'dev' | 'staging' | 'production';
  tags?: string[];
}

// Whitelist request (for creating new entries)
export interface WhitelistRequest {
  ipAddress: string;
  description: string;
  expiresAt?: string;
  region: string;
  environment: 'dev' | 'staging' | 'production';
  tags?: string[];
}

// Whitelist update request
export interface WhitelistUpdateRequest {
  description?: string;
  expiresAt?: string;
  tags?: string[];
}

// Approval request
export interface ApprovalRequest {
  approved: boolean;
  comments?: string;
}

// Filter parameters
export interface WhitelistFilters {
  status?: RequestStatus;
  environment?: 'dev' | 'staging' | 'production';
  region?: string;
  requestedBy?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}

// Pagination parameters
export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Combined query parameters
export type WhitelistQueryParams = WhitelistFilters & PaginationParams;

// Audit log entry
export interface AuditLog {
  id: string;
  action: 'create' | 'update' | 'delete' | 'approve' | 'reject';
  entityType: 'whitelist';
  entityId: string;
  performedBy: string;
  performedAt: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
}

// Dashboard statistics
export interface DashboardStats {
  totalRequests: number;
  pendingRequests: number;
  approvedRequests: number;
  rejectedRequests: number;
  expiringSoon: number;
  recentActivity: AuditLog[];
}

// User profile
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'approver' | 'requester';
  department?: string;
  createdAt: string;
  lastLogin?: string;
}

// Notification
export interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  actionUrl?: string;
}

// Export request
export interface ExportRequest {
  format: 'csv' | 'json' | 'xlsx';
  filters?: WhitelistFilters;
}

// Bulk operation request
export interface BulkOperationRequest {
  ids: string[];
  action: 'approve' | 'reject' | 'delete';
  comments?: string;
}

// Bulk operation response
export interface BulkOperationResponse {
  successful: string[];
  failed: Array<{
    id: string;
    error: string;
  }>;
}
