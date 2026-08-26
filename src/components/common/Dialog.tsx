import {
  Dialog as MuiDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogProps as MuiDialogProps,
} from '@mui/material';
import { ReactNode } from 'react';

export interface DialogProps extends Omit<MuiDialogProps, 'title'> {
  open: boolean;
  onClose: () => void;
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, actions, children, ...props }: DialogProps) {
  return (
    <MuiDialog open={open} onClose={onClose} {...props}>
      {title && <DialogTitle>{title}</DialogTitle>}
      <DialogContent>{children}</DialogContent>
      {actions && <DialogActions>{actions}</DialogActions>}
    </MuiDialog>
  );
}
