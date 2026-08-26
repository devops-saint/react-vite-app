import { Card, CardContent, CardHeader, Typography } from '@mui/material';
import { AuditLog } from '@/types';
import { Timeline, TimelineItemData } from '@/components/common';
import { EmptyState } from '@/components/common';

export interface RecentActivityProps {
  activities: AuditLog[];
  loading?: boolean;
}

export function RecentActivity({ activities, loading }: RecentActivityProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader title="Recent Activity" />
        <CardContent>
          <Typography color="text.secondary">Loading...</Typography>
        </CardContent>
      </Card>
    );
  }

  if (activities.length === 0) {
    return (
      <Card>
        <CardHeader title="Recent Activity" />
        <CardContent>
          <EmptyState
            title="No recent activity"
            message="There is no recent activity to display."
          />
        </CardContent>
      </Card>
    );
  }

  const timelineItems: TimelineItemData[] = activities.map((activity) => ({
    id: activity.id,
    title: `${activity.action.charAt(0).toUpperCase() + activity.action.slice(1)} ${activity.entityType}`,
    description: `By ${activity.performedBy}${activity.ipAddress ? ` • IP: ${activity.ipAddress}` : ''}`,
    date: new Date(activity.performedAt).toLocaleString(),
    color:
      activity.action === 'approve'
        ? 'success'
        : activity.action === 'reject'
        ? 'error'
        : activity.action === 'delete'
        ? 'error'
        : 'primary',
  }));

  return (
    <Card>
      <CardHeader title="Recent Activity" />
      <CardContent>
        <Timeline items={timelineItems} />
      </CardContent>
    </Card>
  );
}
