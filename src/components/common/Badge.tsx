import { Badge as MuiBadge, BadgeProps as MuiBadgeProps } from '@mui/material';

export interface BadgeProps extends MuiBadgeProps {
  children: React.ReactNode;
}

export function Badge({ children, ...props }: BadgeProps) {
  return <MuiBadge {...props}>{children}</MuiBadge>;
}
