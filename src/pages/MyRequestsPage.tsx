import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { config, buildRequestDetailsPath } from '@/config';
import {
  Box,
  Container,
  Typography,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  TextField,
  MenuItem,
  Chip,
  IconButton,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import {
  WhitelistRequest,
  RequestStatus,
  getStatusConfig,
} from '@/types/request.types';
import { Loader, EmptyState, ErrorState } from '@/components/common';

export function MyRequestsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<WhitelistRequest[]>([]);
  const [filteredRequests, setFilteredRequests] = useState<WhitelistRequest[]>(
    []
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<RequestStatus | 'ALL'>(
    'ALL'
  );
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      if (!user?.id) return;
      const data = await requestService.getAllRequests(user.id);
      setRequests(data);
      setFilteredRequests(data);
    } catch (err) {
      setError('Failed to load requests');
      console.error('Error fetching requests:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    let filtered = requests;

    // Apply search filter
    if (searchQuery) {
      filtered = filtered.filter(
        (req) =>
          req.requestId.toLowerCase().includes(searchQuery.toLowerCase()) ||
          req.marketCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
          req.marketName.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Apply status filter
    if (statusFilter !== 'ALL') {
      filtered = filtered.filter((req) => req.status === statusFilter);
    }

    setFilteredRequests(filtered);
    setPage(0); // Reset to first page when filters change
  }, [searchQuery, statusFilter, requests]);

  const handleChangePage = (_event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleRowClick = (requestId: string) => {
    navigate(buildRequestDetailsPath(requestId));
  };

  if (loading) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Loader message="Loading requests..." />
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <ErrorState
          title="Failed to load requests"
          message={error}
          onRetry={() => void fetchRequests()}
        />
      </Container>
    );
  }

  if (requests.length === 0) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <EmptyState
          title="No requests found"
          message="You haven't created any whitelist requests yet."
          action={{
            label: 'Create Request',
            onClick: () => navigate(config.routes.requestsCreate),
          }}
        />
      </Container>
    );
  }

  const paginatedRequests = filteredRequests.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight="bold" gutterBottom>
            My Requests
          </Typography>
          <Typography variant="body1" color="text.secondary">
            View and manage your whitelist requests
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <IconButton onClick={() => void fetchRequests()} title="Refresh">
            <RefreshIcon />
          </IconButton>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(config.routes.requestsCreate)}
          >
            Create Request
          </Button>
        </Box>
      </Box>

      {/* Filters */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            label="Search"
            variant="outlined"
            size="small"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by ID, application, or market..."
            sx={{ flexGrow: 1, minWidth: 300 }}
          />
          <TextField
            select
            label="Status"
            variant="outlined"
            size="small"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as RequestStatus | 'ALL')
            }
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="ALL">All Statuses</MenuItem>
            <MenuItem value="SUBMITTED">Submitted</MenuItem>
            <MenuItem value="BRANCH_CREATED">Branch Created</MenuItem>
            <MenuItem value="PULL_REQUEST_CREATED">PR Created</MenuItem>
            <MenuItem value="PENDING_APPROVAL">Pending Approval</MenuItem>
            <MenuItem value="MERGED">Merged</MenuItem>
            <MenuItem value="COMPLETED">Completed</MenuItem>
            <MenuItem value="REJECTED">Rejected</MenuItem>
          </TextField>
        </Box>
      </Paper>

      {/* Results Count */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Showing {filteredRequests.length} of {requests.length} requests
        </Typography>
      </Box>

      {/* Table */}
      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Request ID</TableCell>
                <TableCell>Market</TableCell>
                <TableCell align="center">Environments</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created Date</TableCell>
                <TableCell>Updated Date</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paginatedRequests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                    <Typography variant="body1" color="text.secondary">
                      No requests match your filters
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRequests.map((request) => (
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
                    <TableCell align="center">
                      <Chip
                        label={request.environments.length}
                        size="small"
                        color="primary"
                        variant="outlined"
                      />
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
                    <TableCell>
                      {new Date(request.updatedAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[5, 10, 25, 50]}
          component="div"
          count={filteredRequests.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </Paper>
    </Container>
  );
}
