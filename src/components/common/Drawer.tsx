import { Drawer as MuiDrawer, DrawerProps as MuiDrawerProps, Box, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ReactNode } from 'react';

export interface DrawerProps extends MuiDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, children, anchor = 'right', ...props }: DrawerProps) {
  return (
    <MuiDrawer open={open} onClose={onClose} anchor={anchor} {...props}>
      <Box sx={{ width: anchor === 'top' || anchor === 'bottom' ? 'auto' : 400, p: 3 }}>
        {title && (
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6">{title}</Typography>
            <IconButton onClick={onClose} size="small">
              <CloseIcon />
            </IconButton>
          </Box>
        )}
        {children}
      </Box>
    </MuiDrawer>
  );
}
