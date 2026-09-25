import { config } from '@/config';

export interface PolicyStatementPreview {
  Sid: string;
  Effect: 'Allow';
  Action: string[];
  Resource: string[];
}

export interface PolicyPreviewDocument {
  Version: '2012-10-17';
  Statement: PolicyStatementPreview[];
}

// Flat, resource-type-keyed shape both CreateRequestPage (staged, not yet
// submitted) and RequestDetailsPage/CurrentWhitelistPage (already
// submitted/live) can each normalize their own data into, so one builder
// serves both call sites.
export interface PolicyPreviewInput {
  s3Buckets: string[];
  secretsManager: string[];
  kmsKeys: string[];
  lambdaFunctions: string[];
}

export const EMPTY_POLICY_PREVIEW_INPUT: PolicyPreviewInput = {
  s3Buckets: [],
  secretsManager: [],
  kmsKeys: [],
  lambdaFunctions: [],
};

/**
 * Builds a representative cross-account IAM policy document for the
 * given resources - one statement per resource type that has at least
 * one entry, using config.policyTemplates for the action list (see that
 * config block for why these actions are illustrative, not the real
 * template). S3 entries are bucket names (not full ARNs, matching how
 * they're staged/stored elsewhere), so each gets both the bucket-level
 * and object-level ARN form; Secrets/KMS/Lambda entries are already full
 * ARNs and are used as-is.
 */
export function buildPolicyPreview(resources: PolicyPreviewInput): PolicyPreviewDocument {
  const statements: PolicyStatementPreview[] = [];

  if (resources.s3Buckets.length > 0) {
    statements.push({
      Sid: 'S3Access',
      Effect: 'Allow',
      Action: config.policyTemplates.s3,
      Resource: resources.s3Buckets.flatMap((bucket) => {
        // Already a full ARN if the user entered one on Create Request;
        // otherwise build the bucket + bucket/* pair from the plain name.
        if (bucket.startsWith('arn:aws:s3:::')) {
          return [bucket, `${bucket}/*`];
        }
        return [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`];
      }),
    });
  }

  if (resources.secretsManager.length > 0) {
    statements.push({
      Sid: 'SecretsManagerAccess',
      Effect: 'Allow',
      Action: config.policyTemplates.secretsManager,
      Resource: resources.secretsManager,
    });
  }

  if (resources.kmsKeys.length > 0) {
    statements.push({
      Sid: 'KmsAccess',
      Effect: 'Allow',
      Action: config.policyTemplates.kmsKeys,
      Resource: resources.kmsKeys,
    });
  }

  if (resources.lambdaFunctions.length > 0) {
    statements.push({
      Sid: 'LambdaAccess',
      Effect: 'Allow',
      Action: config.policyTemplates.lambdaFunctions,
      Resource: resources.lambdaFunctions,
    });
  }

  return { Version: '2012-10-17', Statement: statements };
}
