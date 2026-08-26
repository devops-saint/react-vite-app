import { Chip, ChipProps } from '@mui/material';

export type Status = 'active' | 'inactive' | 'pending' | 'approved' | 'rejected' | 'success' | 'error' | 'warning' | 'info';

export interface StatusChipProps extends Omit<ChipProps, 'color'> {
  status: Status;
}

export function StatusChip({ status, ...props }: StatusChipProps) {
  const getColor = (): ChipProps['color'] => {
    switch (status) {
      case 'active':
      case 'approved':
      case 'success':
        return 'success';
      case 'inactive':
      case 'rejected':
      case 'error':
        return 'error';
      case 'pending':
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'default';
    }
  };

  return (
    <Chip
      label={status.charAt(0).toUpperCase() + status.slice(1)}
      color={getColor()}
      size="small"
      {...props}
    />
  );
}
