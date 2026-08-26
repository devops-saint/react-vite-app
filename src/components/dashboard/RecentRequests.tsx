import { Card, CardContent, CardHeader, List, ListItem, ListItemText, Chip, Box, Typography } from '@mui/material';
import { WhitelistEntry } from '@/types';
import { EmptyState } from '@/components/common';

export interface RecentRequestsProps {
  requests: WhitelistEntry[];
  loading?: boolean;
}

export function RecentRequests({ requests, loading }: RecentRequestsProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader title="Recent Requests" />
        <CardContent>
          <Typography color="text.secondary">Loading...</Typography>
        </CardContent>
      </Card>
    );
  }

  if (requests.length === 0) {
    return (
      <Card>
        <CardHeader title="Recent Requests" />
        <CardContent>
          <EmptyState
            title="No recent requests"
            message="There are no recent whitelist requests to display."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Recent Requests" />
      <CardContent sx={{ pt: 0 }}>
        <List>
          {requests.map((request, index) => (
            <ListItem
              key={request.id}
              divider={index < requests.length - 1}
              sx={{ px: 0 }}
            >
              <ListItemText
                primary={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body1" fontWeight="500">
                      {request.ipAddress}
                    </Typography>
                    <Chip
                      label={request.status}
                      size="small"
                      color={
                        request.status === 'approved'
                          ? 'success'
                          : request.status === 'pending'
                          ? 'warning'
                          : request.status === 'rejected'
                          ? 'error'
                          : 'default'
                      }
                    />
                  </Box>
                }
                secondary={
                  <Box>
                    <Typography variant="caption" display="block">
                      {request.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Requested by {request.requestedBy} • {new Date(request.requestedAt).toLocaleDateString()}
                    </Typography>
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      </CardContent>
    </Card>
  );
}
