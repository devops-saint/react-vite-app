import { Box, CircularProgress, Typography } from '@mui/material';

export interface LoaderProps {
  message?: string;
  size?: number;
}

export function Loader({ message, size = 40 }: LoaderProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
        gap: 2,
      }}
    >
      <CircularProgress size={size} />
      {message && <Typography color="text.secondary">{message}</Typography>}
    </Box>
  );
}
