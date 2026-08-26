import { Box, Typography, Divider, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ReactNode } from 'react';

export interface FilterPanelProps {
  title?: string;
  onClear?: () => void;
  children: ReactNode;
}

export function FilterPanel({ title = 'Filters', onClear, children }: FilterPanelProps) {
  return (
    <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">{title}</Typography>
        {onClear && (
          <IconButton size="small" onClick={onClear}>
            <CloseIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
      <Divider sx={{ mb: 2 }} />
      {children}
    </Box>
  );
}
