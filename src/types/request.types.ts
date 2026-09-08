// Request Status Lifecycle
export type RequestStatus =
  | 'SUBMITTED'
  | 'BRANCH_CREATED'
  | 'PULL_REQUEST_CREATED'
  | 'PENDING_APPROVAL'
  | 'MERGED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'REQUEST_RECEIVED' // Added backend status
  | 'QUEUED' // held back: another request for the same market is already in flight (see MARKETLOCK# in lambda/handler.py)
  // GitOps webhook statuses (set by the PR webhook as the linked PR progresses)
  | 'PR_CREATED'
  | 'PR_UPDATED'
  | 'PR_APPROVED'
  | 'PR_NEEDS_WORK'
  | 'PR_DECLINED'
  | 'PR_DELETED'
  | 'SYNC_FAILED' // an automated gitops step failed; auto-retried on a schedule
  | 'UNKNOWN';

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
  // Which environment/branch (DEV/QA/PRD) this transition belongs to -
  // lets the UI distinguish "PR Approved" on dev from the same status on
  // qa/master, since the status string itself is shared across stages.
  stage?: string;
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
  // From stage_summary() in lambda/handler.py - optional because the
  // list-lookup fallback path in requestService.ts (getRequestById)
  // doesn't reconstruct these. Keyed by environment (DEV/QA/PRD).
  targetEnvironment?: string;
  currentStage?: string;
  prs?: Record<string, string | number | null>;
  // Human-viewable Bitbucket PR links per stage - admin-only "view PR"
  // link on the request-details page. Null where a PR id isn't on
  // record yet, or the backend has no Bitbucket URL configured.
  prUrls?: Record<string, string | null>;
  // Only set when status is QUEUED - the request_id currently holding
  // this market's lock, so the UI can explain what this one is waiting
  // on. Undefined if nothing was queued ahead of it, or the lock lookup
  // came back empty.
  blockedBy?: string | null;
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

// Current Whitelist (GET /dpc/whitelist/{marketCode}/{environment} - what's
// already whitelisted on a given node, read live off the source-controlled
// values.<env>.yaml rather than anything the portal itself has recorded).
export interface CurrentWhitelist {
  marketCode: string;
  environment: string;
  filePath: string;
  // false when the file has never been created for this market/environment
  // (a 404 from the repo - a normal, expected state, not an error).
  exists: boolean;
  buckets: string[];
  secrets: string[];
  kmsKeys: string[];
  functions: string[];
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
  QUEUED: { label: 'Queued', color: 'default' },
  // GitOps webhook statuses
  PR_CREATED: { label: 'PR Created', color: 'primary' },
  PR_UPDATED: { label: 'PR Updated', color: 'primary' },
  PR_APPROVED: { label: 'PR Approved', color: 'success' },
  PR_NEEDS_WORK: { label: 'Needs Work', color: 'warning' },
  PR_DECLINED: { label: 'PR Declined', color: 'error' },
  PR_DELETED: { label: 'PR Deleted', color: 'default' },
  SYNC_FAILED: { label: 'Sync Failed (retrying)', color: 'error' },
  UNKNOWN: { label: 'Unknown', color: 'default' },
};

/**
 * Safe lookup for STATUS_CONFIG. Falls back to a generic entry instead of
 * throwing when the backend reports a status the frontend doesn't know
 * about yet (e.g. a new GitOps webhook event type) - status values are
 * managed independently by the backend, so this must never assume the
 * map is exhaustive.
 */
export const getStatusConfig = (
  status: string
): { label: string; color: (typeof STATUS_CONFIG)[RequestStatus]['color'] } =>
  STATUS_CONFIG[status as RequestStatus] ?? { label: status || 'Unknown', color: 'default' };

// ========================================
// Dashboard status groups
// ========================================
// The Dashboard's four summary cards (Pending/Approved/Rejected/Completed)
// each bucket several raw backend statuses together - this is the single
// source of truth for that bucketing, used both by requestService's
// getDashboardStats (to compute the card counts) and by MyRequestsPage (so
// clicking a card can filter My Requests down to exactly the same set the
// card counted - see the `statusGroup` query param there). Keeping one
// definition means the two can never quietly drift apart.
export type StatusGroup = 'pending' | 'approved' | 'rejected' | 'completed';

export const STATUS_GROUPS: StatusGroup[] = ['pending', 'approved', 'rejected', 'completed'];

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  pending: 'Pending Requests',
  approved: 'Approved Requests',
  rejected: 'Rejected Requests',
  completed: 'Completed Requests',
};

// A request sitting at e.g. DEV_MERGED_AWAITING_QA between promotion
// stages - not a status in the RequestStatus union above (it's assembled
// by the backend from ENV_TO_BRANCH, not a fixed literal), so it's matched
// by pattern instead of an exact equality check.
const isPromotionInProgress = (status: string): boolean => /_MERGED_AWAITING_/.test(status);

export const matchesStatusGroup = (status: string, group: StatusGroup): boolean => {
  switch (group) {
    case 'pending':
      return (
        status === 'REQUEST_RECEIVED' ||
        status === 'QUEUED' ||
        status === 'PR_CREATED' ||
        status === 'PR_UPDATED' ||
        status === 'PR_NEEDS_WORK' ||
        status === 'SYNC_FAILED' ||
        isPromotionInProgress(status)
      );
    case 'approved':
      return status === 'PR_APPROVED';
    case 'rejected':
      return status === 'PR_DECLINED' || status === 'PR_DELETED';
    case 'completed':
      return status === 'COMPLETED';
    default:
      return false;
  }
};

export const isStatusGroup = (value: string | null): value is StatusGroup =>
  value !== null && (STATUS_GROUPS as string[]).includes(value);

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
  // REQUEST_RECEIVED if this request's market lock was free, QUEUED if
  // another in-flight request for the same market already held it (see
  // POST /dpc/request in lambda/handler.py).
  status?: string;
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
