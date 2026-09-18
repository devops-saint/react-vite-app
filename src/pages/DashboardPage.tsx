import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildRequestDetailsPath, config } from '@/config';
import {
  Box,
  Container,
  Typography,
  Grid,
  Card,
  CardActionArea,
  CardContent,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Stack,
  Button,
} from '@mui/material';
import PendingIcon from '@mui/icons-material/Pending';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import AddIcon from '@mui/icons-material/Add';
import AssignmentIcon from '@mui/icons-material/Assignment';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { useAuth } from '@/auth';
import { requestService } from '@/api/services';
import { WhitelistRequest, getUserFacingStatus, StatusGroup } from '@/types/request.types';
import { Loader, StatusChip } from '@/components/common';

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    pending: 0,
    inProgress: 0,
    completed: 0,
  });
  const [recentRequests, setRecentRequests] = useState<WhitelistRequest[]>([]);

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setLoading(true);
        if (!user?.id) return;
        const [statsData, recentData] = await Promise.all([
          requestService.getDashboardStats(user.id),
          requestService.getRecentRequests(user.id),
        ]);
        setStats(statsData);
        setRecentRequests(recentData);
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };

    void fetchDashboardData();
  }, [user?.id]);

  const handleRowClick = (requestId: string) => {
    navigate(buildRequestDetailsPath(requestId));
  };

  // Sends the viewer to My Requests pre-filtered to exactly the statuses
  // this card counted (see matchesStatusGroup in request.types.ts, also
  // used by requestService.getDashboardStats for the counts themselves).
  const handleStatCardClick = (group: StatusGroup) => {
    navigate(`${config.routes.requests}?statusGroup=${group}`);
  };

  if (loading) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Loader message="Loading dashboard..." />
      </Container>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* Welcome Section */}
      <Box
        sx={{
          mb: 4,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', sm: 'center' },
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight="bold" gutterBottom>
            Welcome, {user?.name || 'User'}!
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Manage your AWS resource whitelist requests
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap">
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(config.routes.requestsCreate)}
          >
            Create Request
          </Button>
          <Button
            variant="outlined"
            startIcon={<AssignmentIcon />}
            onClick={() => navigate(config.routes.requests)}
          >
            My Requests
          </Button>
          <Button
            variant="outlined"
            startIcon={<Inventory2Icon />}
            onClick={() => navigate(config.routes.whitelist)}
          >
            View Whitelist
          </Button>
          <Button
            variant="outlined"
            startIcon={<HelpOutlineIcon />}
            onClick={() => navigate(config.routes.help)}
          >
            Help
          </Button>
        </Stack>
      </Box>

      {/* Summary Cards - the three collapsed user-facing statuses (see
          getUserFacingStatus in request.types.ts). A declined/deleted PR or
          a rejected request lands under Completed too - the lifecycle has
          ended and the requester is already notified by email - so there
          is no separate "failed" bucket. Icon colors intentionally stay off
          the success(green)/error(red) axis. */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
          <CardActionArea onClick={() => handleStatCardClick('pending')}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    gutterBottom
                  >
                    Pending
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.pending}
                  </Typography>
                </Box>
                <PendingIcon
                  sx={{ fontSize: 48, color: 'text.disabled', opacity: 0.6 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={4}>
          <Card>
          <CardActionArea onClick={() => handleStatCardClick('in_progress')}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    gutterBottom
                  >
                    In Progress
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.inProgress}
                  </Typography>
                </Box>
                <AutorenewIcon
                  sx={{ fontSize: 48, color: 'info.main', opacity: 0.3 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={4}>
          <Card>
          <CardActionArea onClick={() => handleStatCardClick('completed')}>
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    gutterBottom
                  >
                    Completed
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.completed}
                  </Typography>
                </Box>
                <TaskAltIcon
                  sx={{ fontSize: 48, color: 'primary.main', opacity: 0.3 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>
      </Grid>

      {/* Recent Requests */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" fontWeight="bold" gutterBottom>
          Recent Requests
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Your latest 5 whitelist requests
        </Typography>

        {recentRequests.length === 0 ? (
          <Box sx={{ py: 4, textAlign: 'center' }}>
            <Typography variant="body1" color="text.secondary">
              No requests found. Create your first request to get started.
            </Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Request ID</TableCell>
                  <TableCell>Market</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created Date</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {recentRequests.map((request) => (
                  <TableRow
                    key={request.requestId}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => handleRowClick(request.requestId)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight="medium">
                        {request.requestId}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {request.marketCode.toUpperCase()} - {request.marketName}
                    </TableCell>
                    <TableCell>
                      <StatusChip status={getUserFacingStatus(request.status)} />
                    </TableCell>
                    <TableCell>
                      {new Date(request.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Container>
  );
}
