import { Alert as MuiAlert, AlertProps as MuiAlertProps, AlertTitle } from '@mui/material';

export interface AlertProps extends MuiAlertProps {
  title?: string;
}

export function Alert({ title, children, ...props }: AlertProps) {
  return (
    <MuiAlert {...props}>
      {title && <AlertTitle>{title}</AlertTitle>}
      {children}
    </MuiAlert>
  );
}
