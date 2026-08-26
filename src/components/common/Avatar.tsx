import { Avatar as MuiAvatar, AvatarProps as MuiAvatarProps } from '@mui/material';

export interface AvatarProps extends MuiAvatarProps {
  name?: string;
  src?: string;
}

export function Avatar({ name, src, ...props }: AvatarProps) {
  const getInitials = (name: string) => {
    const parts = name.split(' ');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <MuiAvatar src={src} {...props}>
      {!src && name && getInitials(name)}
    </MuiAvatar>
  );
}
