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
  Chip,
  Stack,
  Button,
} from '@mui/material';
import PendingIcon from '@mui/icons-material/Pending';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import AddIcon from '@mui/icons-material/Add';
import AssignmentIcon from '@mui/icons-material/Assignment';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { useAuth } from '@/auth';
import { requestService } from '@/api/services';
import { WhitelistRequest, getStatusConfig, StatusGroup } from '@/types/request.types';
import { Loader } from '@/components/common';

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    pending: 0,
    approved: 0,
    rejected: 0,
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

      {/* Summary Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
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
                    Pending Requests
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.pending}
                  </Typography>
                </Box>
                <PendingIcon
                  sx={{ fontSize: 48, color: 'warning.main', opacity: 0.3 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
          <CardActionArea onClick={() => handleStatCardClick('approved')}>
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
                    Approved Requests
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.approved}
                  </Typography>
                </Box>
                <CheckCircleIcon
                  sx={{ fontSize: 48, color: 'primary.main', opacity: 0.3 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
          <CardActionArea onClick={() => handleStatCardClick('rejected')}>
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
                    Rejected Requests
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.rejected}
                  </Typography>
                </Box>
                <CancelIcon
                  sx={{ fontSize: 48, color: 'error.main', opacity: 0.3 }}
                />
              </Box>
            </CardContent>
          </CardActionArea>
        </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
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
                    Completed Requests
                  </Typography>
                  <Typography variant="h4" fontWeight="bold">
                    {stats.completed}
                  </Typography>
                </Box>
                <TaskAltIcon
                  sx={{ fontSize: 48, color: 'success.main', opacity: 0.3 }}
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
                      {request.marketCode} - {request.marketName}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={getStatusConfig(request.status).label}
                        color={getStatusConfig(request.status).color}
                        size="small"
                      />
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
