import { z } from 'zod';

// S3 Bucket Name Validation (AWS naming rules)
const s3BucketNameRegex = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// ARN Validation Patterns
const secretsManagerArnRegex = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;
const kmsArnRegex = /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/;
const lambdaArnRegex = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:.+$/;

// S3 Bucket Schema
export const s3BucketSchema = z.object({
  bucketName: z
    .string()
    .min(3, 'Bucket name must be at least 3 characters')
    .max(63, 'Bucket name must not exceed 63 characters')
    .regex(s3BucketNameRegex, 'Invalid S3 bucket name format'),
});

// Secrets Manager Schema
export const secretsManagerSchema = z.object({
  secretArn: z
    .string()
    .min(1, 'Secret ARN is required')
    .regex(secretsManagerArnRegex, 'Invalid Secrets Manager ARN format'),
});

// KMS Key Schema
export const kmsKeySchema = z.object({
  keyArn: z
    .string()
    .min(1, 'KMS Key ARN is required')
    .regex(kmsArnRegex, 'Invalid KMS Key ARN format'),
});

// Lambda Function Schema
export const lambdaFunctionSchema = z.object({
  functionArn: z
    .string()
    .min(1, 'Lambda Function ARN is required')
    .regex(lambdaArnRegex, 'Invalid Lambda Function ARN format'),
});

// Environment Resources Schema
export const environmentResourcesSchema = z.object({
  s3Buckets: z.array(s3BucketSchema),
  secretsManager: z.array(secretsManagerSchema),
  kmsKeys: z.array(kmsKeySchema),
  lambdaFunctions: z.array(lambdaFunctionSchema),
});

// Environment Schema
export const environmentSchema = z.object({
  environment: z.enum(['DEV', 'QA', 'PRD']),
  resources: environmentResourcesSchema,
});

// Create Request Schema
export const createRequestSchema = z.object({
  // Application Information
  marketCode: z.string().min(1, 'Market code is required'),
  marketName: z.string().min(1, 'Market name is required'),
  businessJustification: z
    .string()
    .min(20, 'Business justification must be at least 20 characters')
    .max(1000, 'Business justification must not exceed 1000 characters'),

  // Environments
  environments: z
    .array(environmentSchema)
    .min(1, 'At least one environment is required'),
});

export type CreateRequestSchema = z.infer<typeof createRequestSchema>;
export type EnvironmentSchema = z.infer<typeof environmentSchema>;
export type S3BucketSchema = z.infer<typeof s3BucketSchema>;
export type SecretsManagerSchema = z.infer<typeof secretsManagerSchema>;
export type KMSKeySchema = z.infer<typeof kmsKeySchema>;
export type LambdaFunctionSchema = z.infer<typeof lambdaFunctionSchema>;

// Inline Validators
export const validateS3BucketName = (name: string): boolean => {
  return s3BucketNameRegex.test(name);
};

export const validateSecretsManagerArn = (arn: string): boolean => {
  return secretsManagerArnRegex.test(arn);
};

export const validateKMSKeyArn = (arn: string): boolean => {
  return kmsArnRegex.test(arn);
};

export const validateLambdaFunctionArn = (arn: string): boolean => {
  return lambdaArnRegex.test(arn);
};

// Duplicate Detection
export const detectDuplicates = (values: string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  values.forEach((value) => {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  });

  return Array.from(duplicates);
};

// Bulk Paste Parser for S3 Buckets
export const parseS3BucketNames = (text: string): string[] => {
  return text
    .split(/[\n,;]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

// Bulk Paste Parser for ARNs
export const parseArns = (text: string): string[] => {
  return text
    .split(/[\n,;]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith('arn:aws:'));
};
