import { Snackbar as MuiSnackbar, Alert, AlertColor } from '@mui/material';

export interface SnackbarProps {
  open: boolean;
  message: string;
  severity?: AlertColor;
  onClose: () => void;
  autoHideDuration?: number;
}

export function Snackbar({
  open,
  message,
  severity = 'info',
  onClose,
  autoHideDuration = 6000,
}: SnackbarProps) {
  return (
    <MuiSnackbar
      open={open}
      autoHideDuration={autoHideDuration}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
    >
      <Alert onClose={onClose} severity={severity} variant="filled">
        {message}
      </Alert>
    </MuiSnackbar>
  );
}
