import { Box, Paper, Typography } from '@mui/material';
import { ReactNode } from 'react';

export interface FormWrapperProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  onSubmit?: (e: React.FormEvent) => void;
}

export function FormWrapper({ title, subtitle, children, onSubmit }: FormWrapperProps) {
  return (
    <Paper sx={{ p: 3 }}>
      {(title || subtitle) && (
        <Box sx={{ mb: 3 }}>
          {title && <Typography variant="h5" gutterBottom>{title}</Typography>}
          {subtitle && <Typography variant="body2" color="text.secondary">{subtitle}</Typography>}
        </Box>
      )}
      <Box component="form" onSubmit={onSubmit} noValidate>
        {children}
      </Box>
    </Paper>
  );
}
