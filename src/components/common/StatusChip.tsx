import { Chip, ChipProps } from '@mui/material';
import { UserFacingStatus, USER_FACING_STATUS_CONFIG } from '@/types/request.types';

export interface StatusChipProps extends Omit<ChipProps, 'color' | 'label'> {
  status: UserFacingStatus;
}

/**
 * The single status badge used everywhere a request's status is shown to
 * a user (Dashboard, My Requests, Request Details). Always renders one of
 * the four collapsed UserFacingStatus values - never a raw backend status
 * like PR_APPROVED or SYNC_FAILED (see getUserFacingStatus in
 * request.types.ts) - and never MUI's 'success'/'error' chip colors, so a
 * status badge is never mistaken for a pass/fail verdict.
 */
export function StatusChip({ status, ...props }: StatusChipProps) {
  const { label, chipColor } = USER_FACING_STATUS_CONFIG[status];

  return <Chip label={label} color={chipColor} size="small" {...props} />;
}
