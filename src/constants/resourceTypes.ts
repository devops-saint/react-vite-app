import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import type { SvgIconComponent } from '@mui/icons-material';

export type ResourceType = 's3Buckets' | 'secretsManager' | 'kmsKeys' | 'lambdaFunctions';

export interface ResourceTypeMeta {
  label: string;
  icon: SvgIconComponent;
  // A neutral, non-AWS-category palette shared by every place a resource
  // type is shown (create-request form, request details, current
  // whitelist) - each type keeps one fixed color/icon pairing so it's
  // recognizable at a glance, but none of the four sit on a red/green
  // axis that could read as "this one failed" / "this one succeeded".
  color: string;
}

// Icons match AWS's own Architecture Icons per resource type (Storage,
// Security/Identity/Compliance x2, Compute) - kept as-is, since the icon
// shape is what makes each type recognizable at a glance. The color is
// deliberately NOT AWS's category palette (Storage green, Security red,
// Compute orange) - Secrets Manager and KMS Keys used to both render in
// the same red used elsewhere in the portal for errors/rejections. Every
// resource type now shares one single neutral color (the same primary
// blue used for non-status accents on the Dashboard), so color carries no
// per-type or success/failure meaning at all - only the icon does.
export const NEUTRAL_RESOURCE_COLOR = '#1976d2';

export const RESOURCE_TYPE_META: Record<ResourceType, ResourceTypeMeta> = {
  s3Buckets: { label: 'S3 Buckets', icon: StorageOutlinedIcon, color: NEUTRAL_RESOURCE_COLOR },
  secretsManager: { label: 'Secrets Manager', icon: VpnKeyOutlinedIcon, color: NEUTRAL_RESOURCE_COLOR },
  kmsKeys: { label: 'KMS Keys', icon: LockOutlinedIcon, color: NEUTRAL_RESOURCE_COLOR },
  lambdaFunctions: { label: 'Lambda Functions', icon: FunctionsOutlinedIcon, color: NEUTRAL_RESOURCE_COLOR },
};

export const RESOURCE_TYPES: ResourceType[] = ['s3Buckets', 'secretsManager', 'kmsKeys', 'lambdaFunctions'];
