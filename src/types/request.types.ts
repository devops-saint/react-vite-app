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
  | 'CANCELLED' // requester cancelled before the request merged to dev - see /cancel in lambda/handler.py
  | 'PENDING_AWS_VERIFICATION' // git side is done (final-stage PR merged); waiting on handle_validation_sweep to confirm the change is actually live in AWS before COMPLETED - see lambda/handler.py
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
  // From stage_summary() in lambda/handler.py - present on both the list
  // endpoint (/dpc/listrequests) and the single-request endpoint, so an
  // admin-only PR-link affordance can render from either the My Requests
  // list or the Request Details page. Human-viewable Bitbucket PR link
  // per stage; null where a PR id isn't on record yet, or the backend
  // has no Bitbucket URL configured.
  prUrls?: Record<string, string | null>;
  // 'DEWHITELIST' for a request submitted from Current Whitelist's remove
  // (X) action - rides through the identical branch/PR/review/promotion
  // pipeline as an ordinary whitelist request, just removing instead of
  // adding the listed resource(s). Undefined/omitted is treated the same
  // as 'WHITELIST' everywhere this is read.
  requestType?: 'WHITELIST' | 'DEWHITELIST';
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
  // (prUrls itself now lives on WhitelistRequest - see above - since the
  // list endpoint returns it too.)
  targetEnvironment?: string;
  currentStage?: string;
  prs?: Record<string, string | number | null>;
  // Only set when status is QUEUED - the request_id currently holding
  // this market's lock, so the UI can explain what this one is waiting
  // on. Undefined if nothing was queued ahead of it, or the lock lookup
  // came back empty.
  blockedBy?: string | null;
  // Set once handle_validation_sweep has made at least one pass over
  // this request (status PENDING_AWS_VERIFICATION) - see the AWS-SIDE
  // ACCESS VERIFICATION block in lambda/handler.py. lastVerificationDetail
  // is a JSON string of {ENV: true|false|null} (null = skipped, no
  // validation role configured for that env), shown as-is rather than
  // parsed since it's purely diagnostic.
  verificationAttempts?: number;
  lastVerificationAttemptAt?: string | null;
  lastVerificationDetail?: string | null;
}

// Dashboard Statistics
export interface DashboardStats {
  pending: number;
  inProgress: number;
  actionNeeded: number;
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
  CANCELLED: { label: 'Cancelled', color: 'default' },
  PENDING_AWS_VERIFICATION: { label: 'Verifying in AWS', color: 'warning' },
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
// User-facing status (collapsed)
// ========================================
// The backend's real status vocabulary (REQUEST_RECEIVED, QUEUED,
// PR_CREATED, PR_UPDATED, PR_APPROVED, PR_NEEDS_WORK, PR_DECLINED,
// PR_DELETED, SYNC_FAILED, COMPLETED, plus dynamic
// "<STAGE>_MERGED_AWAITING_<NEXT>" promotion states) is workflow/Git
// machinery - useful in the audit timeline, not something an end user
// should have to parse to know "where is my request". Every status badge
// shown to a user (Dashboard cards, request lists, the request-details
// header) is collapsed into this small, fixed set instead. This is the
// single source of truth for that collapsing - requestService's
// getDashboardStats (card counts), DashboardPage/MyRequestsPage/
// RequestDetailsPage (badges) and the statusGroup query param all derive
// from getUserFacingStatus so they can never drift apart.
export type UserFacingStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

export const USER_FACING_STATUSES: UserFacingStatus[] = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];

// Neutral palette - deliberately not MUI's 'success'/'error' (bright
// green/red), which reads as "this succeeded" / "this failed". A declined
// or deleted PR lands under COMPLETED too (the request's lifecycle has
// ended - the requester is already told the outcome by email, see
// notify_requester_merged/notify_approvers_* in the Lambdas) rather than
// a separate "failed" bucket, so COMPLETED means "nothing more will
// happen here", not "it was approved". `chipColor` sticks to MUI Chip's
// built-in palette keys (kept off 'success'/'error' everywhere in this
// map) so it renders consistently with the rest of the theme without
// introducing bespoke hex values.
export const USER_FACING_STATUS_CONFIG: Record<
  UserFacingStatus,
  { label: string; chipColor: 'default' | 'primary' | 'info' }
> = {
  PENDING: { label: 'Pending', chipColor: 'default' },
  IN_PROGRESS: { label: 'In Progress', chipColor: 'info' },
  COMPLETED: { label: 'Completed', chipColor: 'primary' },
};

// Maps any raw backend status string to the small user-facing set above.
// Everything else - PR_CREATED, PR_UPDATED, PR_APPROVED, PR_NEEDS_WORK,
// SYNC_FAILED (auto-retried), a dynamic "<STAGE>_MERGED_AWAITING_<NEXT>"
// promotion status, or any status the frontend doesn't recognise yet (a
// new webhook event type, UNKNOWN, ...) - reads as "still moving" to an
// end user rather than erroring or silently disappearing from the UI.
export const getUserFacingStatus = (status: string): UserFacingStatus => {
  switch (status) {
    case 'REQUEST_RECEIVED':
    case 'QUEUED':
    case 'SUBMITTED':
      return 'PENDING';
    case 'PR_DECLINED':
    case 'PR_DELETED':
    case 'REJECTED':
    case 'CANCELLED':
    case 'COMPLETED':
      return 'COMPLETED';
    case 'PENDING_AWS_VERIFICATION':
      // Git is done, but this is deliberately NOT 'COMPLETED' yet - the
      // whole point of gating on AWS-side verification is that the
      // requester shouldn't be told they're done until the access is
      // actually confirmed live. Falls into the same bucket as every
      // other still-moving state.
      return 'IN_PROGRESS';
    default:
      return 'IN_PROGRESS';
  }
};

// Whether a request is still early enough in its lifecycle for the
// requester to cancel it themselves - mirrors the backend's own
// authoritative check (stage_index >= 0, i.e. it has merged to dev) in
// the /dpc/requests/{id}/cancel handler (lambda/handler.py), just from
// the raw status string since stage_index itself isn't exposed to the
// frontend. This is only ever used to decide whether to show/enable the
// Cancel button - the backend re-checks and is the real source of truth,
// so a stale/optimistic client-side status can only hide the button a
// little too eagerly, never let through a cancel that shouldn't succeed.
export const isRequestCancellable = (status: string): boolean => {
  if (status.includes('_MERGED_AWAITING_')) return false;
  switch (status) {
    case 'REQUEST_RECEIVED':
    case 'QUEUED':
    case 'PR_CREATED':
    case 'PR_UPDATED':
    case 'PR_APPROVED':
    case 'PR_NEEDS_WORK':
    case 'SYNC_FAILED':
      return true;
    default:
      return false;
  }
};

// ========================================
// Dashboard status groups
// ========================================
// Lowercase, URL-safe aliases of UserFacingStatus (used as the
// `?statusGroup=` query param and as getDashboardStats' result keys) -
// kept as a distinct type from UserFacingStatus only because query-string
// values and object keys read more naturally lowercase/snake_case than
// SCREAMING_CASE.
export type StatusGroup = 'pending' | 'in_progress' | 'completed';

export const STATUS_GROUPS: StatusGroup[] = ['pending', 'in_progress', 'completed'];

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
};

const USER_FACING_TO_GROUP: Record<UserFacingStatus, StatusGroup> = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
};

export const toStatusGroup = (status: UserFacingStatus): StatusGroup => USER_FACING_TO_GROUP[status];

export const matchesStatusGroup = (status: string, group: StatusGroup): boolean =>
  toStatusGroup(getUserFacingStatus(status)) === group;

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
  // Omitted (equivalent to 'WHITELIST') unless this is a de-whitelist
  // request from Current Whitelist's remove action - see
  // update_yaml_data(request_type=...) in lambda-gitops/handler.py.
  request_type?: 'WHITELIST' | 'DEWHITELIST';
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
    request_type?: string;
  };
  // Merged in by /dpc/listrequests (and /dpc/requests/{id}) via
  // stage_summary() - see WhitelistRequest.prUrls above.
  prUrls?: Record<string, string | null>;
}
