import { Box, Typography, Avatar } from '@mui/material';

export interface TimelineItemData {
  id: string;
  title: string;
  description?: string;
  date?: string;
  color?: 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info' | 'grey';
  icon?: React.ReactNode;
}

export interface TimelineProps {
  items: TimelineItemData[];
}

export function Timeline({ items }: TimelineProps) {
  return (
    <Box>
      {items.map((item, index) => (
        <Box key={item.id} sx={{ display: 'flex', mb: 3 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mr: 2 }}>
            <Avatar
              sx={{
                bgcolor: `${item.color || 'primary'}.main`,
                width: 40,
                height: 40,
              }}
            >
              {item.icon}
            </Avatar>
            {index < items.length - 1 && (
              <Box
                sx={{
                  width: 2,
                  flexGrow: 1,
                  bgcolor: 'divider',
                  my: 1,
                  minHeight: 40,
                }}
              />
            )}
          </Box>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="h6">{item.title}</Typography>
            {item.description && (
              <Typography color="text.secondary" variant="body2">
                {item.description}
              </Typography>
            )}
            {item.date && (
              <Typography variant="caption" color="text.secondary">
                {item.date}
              </Typography>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
