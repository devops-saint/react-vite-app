// Request Status Lifecycle
export type RequestStatus =
  | 'SUBMITTED'
  | 'BRANCH_CREATED'
  | 'PULL_REQUEST_CREATED'
  | 'PENDING_APPROVAL'
  | 'MERGED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'REQUEST_RECEIVED'; // Added backend status

// Environment Types
export type EnvironmentName = 'DEV' | 'QA' | 'PRD';

// S3 Bucket Resource
export interface S3Bucket {
  bucketName: string;
}

// Secrets Manager Resource
export interface SecretsManagerSecret {
  secretArn: string;
}

// KMS Key Resource
export interface KMSKey {
  keyArn: string;
}

// Lambda Function Resource
export interface LambdaFunction {
  functionArn: string;
}

// Environment Resources
export interface EnvironmentResources {
  s3Buckets: S3Bucket[];
  secretsManager: SecretsManagerSecret[];
  kmsKeys: KMSKey[];
  lambdaFunctions: LambdaFunction[];
}

// Environment Configuration
export interface Environment {
  environment: EnvironmentName;
  resources: EnvironmentResources;
}

// Requested By Information
export interface RequestedBy {
  id: string;
  name: string;
  email: string;
}

// AWS Configuration
export interface AWSConfig {
  region: string;
}

// Whitelist Request (Complete Request Object)
export interface WhitelistRequest {
  requestId: string;
  marketCode: string;
  marketName: string;
  repositoryName: string;
  businessJustification: string;
  requestedBy: RequestedBy;
  aws: AWSConfig;
  environments: Environment[];
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
}

// Create Request Form Data
export interface CreateRequestFormData {
  marketCode: string;
  marketName: string;
  businessJustification: string;
  environments: Environment[];
}

// Status History Entry
export interface StatusHistoryEntry {
  status: RequestStatus;
  timestamp: string;
  performedBy?: string;
  comments?: string;
}

// Request Comment
export interface RequestComment {
  id: string;
  author: string;
  content: string;
  timestamp: string;
}

// Request Details (Extended with history and comments)
export interface RequestDetails extends WhitelistRequest {
  history: StatusHistoryEntry[];
  comments: RequestComment[];
}

// Dashboard Statistics
export interface DashboardStats {
  pending: number;
  approved: number;
  rejected: number;
  completed: number;
}

// Market Code Options
export interface MarketOption {
  code: string;
  name: string;
}

// Status Display Configuration
export const STATUS_CONFIG: Record<
  RequestStatus,
  {
    label: string;
    color:
      | 'default'
      | 'primary'
      | 'secondary'
      | 'error'
      | 'info'
      | 'success'
      | 'warning';
  }
> = {
  SUBMITTED: { label: 'Submitted', color: 'info' },
  BRANCH_CREATED: { label: 'Branch Created', color: 'primary' },
  PULL_REQUEST_CREATED: { label: 'PR Created', color: 'primary' },
  PENDING_APPROVAL: { label: 'Pending Approval', color: 'warning' },
  MERGED: { label: 'Merged', color: 'primary' },
  COMPLETED: { label: 'Completed', color: 'success' },
  REJECTED: { label: 'Rejected', color: 'error' },
  REQUEST_RECEIVED: { label: 'Request Received', color: 'info' }, // Added backend status
};

// ========================================
// API Gateway Payload Types
// ========================================

// API Gateway Environment Resource Structure
export interface ApiGatewayEnvironmentResources {
  buckets?: string[];
  secrets?: string[];
  kmsKeys?: string[];
  functions?: string[];
}

// API Gateway Environments Structure
export type ApiGatewayEnvironments = {
  [key in 'dev' | 'qa' | 'prd']?: ApiGatewayEnvironmentResources;
};

// API Gateway Request Payload
export interface ApiGatewayRequestPayload {
  request_id: string;
  market_code: string;
  market_name?: string;
  business_justification?: string;
  submitted_by: RequestedBy;
  environments: ApiGatewayEnvironments;
}

// API Gateway Success Response
export interface ApiGatewaySuccessResponse {
  statusCode: number;
  message: string;
  requestId: string;
  data?: unknown;
}

// API Gateway Error Response
export interface ApiGatewayErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

// ========================================
// List Requests API Response
// ========================================

// Backend response structure for GET /listrequests
export interface ListRequestsResponse {
  count: number;
  requests: WhitelistRequest[];
}

// ========================================
// Backend Raw Response Types
// ========================================

// Raw backend request object with snake_case fields
export interface BackendRequest {
  request_id: string; // UUID
  status: string;
  createdAt: string;
  payload?: {
    request_id?: string; // Human-readable ID like "REQ-xxxxx"
    market_code?: string;
    market_name?: string;
    business_justification?: string;
    repository_name?: string;
    aws_account_id?: string;
    aws_region?: string;
    submitted_by?: RequestedBy;
    environments?: unknown;
  };
}
