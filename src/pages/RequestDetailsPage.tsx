import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Container,
  Typography,
  Button,
  Grid,
  Paper,
  Chip,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Timeline, Loader, ErrorState } from '@/components/common';
import { config } from '@/config';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import { RequestDetails, getStatusConfig } from '@/types/request.types';

export function RequestDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRequest = async () => {
      if (!id || !user?.id) return;

      try {
        setLoading(true);
        const data = await requestService.getRequestById(id, user.id);
        setRequest(data);
      } catch (error) {
        console.error('Failed to fetch request:', error);
      } finally {
        setLoading(false);
      }
    };

    void fetchRequest();
  }, [id, user?.id]);

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  const handleDownload = () => {
    if (!request) return;
    requestService.downloadRequestJson(request);
  };

  if (loading) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Loader message="Loading request details..." />
      </Container>
    );
  }

  if (!request) {
    return (
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <ErrorState
          title="Request not found"
          message="The requested whitelist entry could not be found."
          onRetry={() => navigate(config.routes.requests)}
        />
      </Container>
    );
  }

  const timelineItems = request.history.map((entry) => {
    const statusColor = getStatusConfig(entry.status).color;
    // Map MUI chip colors to Timeline colors
    const timelineColor:
      | 'primary'
      | 'secondary'
      | 'success'
      | 'error'
      | 'warning'
      | 'info'
      | 'grey' = statusColor === 'default' ? 'grey' : statusColor;

    return {
      id: entry.timestamp,
      title: getStatusConfig(entry.status).label,
      description: entry.performedBy ? `By ${entry.performedBy}` : 'System',
      date: new Date(entry.timestamp).toLocaleString(),
      color: timelineColor,
    };
  });

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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton onClick={() => navigate(config.routes.requests)}>
            <ArrowBackIcon />
          </IconButton>
          <Box>
            <Typography variant="h4" fontWeight="bold">
              Request Details
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {request.requestId}
              </Typography>
              <IconButton
                size="small"
                onClick={() => handleCopy(request.requestId)}
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={handleDownload}
          >
            Download JSON
          </Button>
        </Box>
      </Box>

      <Grid container spacing={3}>
        {/* Main Content */}
        <Grid item xs={12} md={8}>
          {/* Request Information */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Request Information
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Request ID
                </Typography>
                <Typography variant="body1">{request.requestId}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Status
                </Typography>
                <Box>
                  <Chip
                    label={getStatusConfig(request.status).label}
                    color={getStatusConfig(request.status).color}
                  />
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Market
                </Typography>
                <Typography variant="body1">
                  {request.marketCode} - {request.marketName}
                </Typography>
              </Grid>
              <Grid item xs={12}>
                <Typography variant="caption" color="text.secondary">
                  Business Justification
                </Typography>
                <Typography variant="body1">
                  {request.businessJustification}
                </Typography>
              </Grid>
            </Grid>
          </Paper>

          {/* AWS Information */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              AWS Information
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  AWS Region
                </Typography>
                <Typography variant="body1">{request.aws.region}</Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Repository
                </Typography>
                <Typography variant="body1">
                  {request.repositoryName}
                </Typography>
              </Grid>
            </Grid>
          </Paper>

          {/* Requested Resources */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Requested Resources
            </Typography>
            <Divider sx={{ mb: 2 }} />
            {request.environments.map((env, idx) => (
              <Box key={idx} sx={{ mb: 3 }}>
                <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                  {env.environment} Environment
                </Typography>
                <Box sx={{ pl: 2 }}>
                  {env.resources.s3Buckets.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="subtitle2"
                        color="primary"
                        gutterBottom
                      >
                        S3 Buckets ({env.resources.s3Buckets.length})
                      </Typography>
                      <List dense>
                        {env.resources.s3Buckets.map((bucket, i) => (
                          <ListItem key={i}>
                            <ListItemText primary={bucket.bucketName} />
                            <IconButton
                              size="small"
                              onClick={() => handleCopy(bucket.bucketName)}
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}
                  {env.resources.secretsManager.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="subtitle2"
                        color="primary"
                        gutterBottom
                      >
                        Secrets Manager ({env.resources.secretsManager.length})
                      </Typography>
                      <List dense>
                        {env.resources.secretsManager.map((secret, i) => (
                          <ListItem key={i}>
                            <ListItemText
                              primary={secret.secretArn}
                              primaryTypographyProps={{
                                variant: 'body2',
                                sx: { wordBreak: 'break-all' },
                              }}
                            />
                            <IconButton
                              size="small"
                              onClick={() => handleCopy(secret.secretArn)}
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}
                  {env.resources.kmsKeys.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="subtitle2"
                        color="primary"
                        gutterBottom
                      >
                        KMS Keys ({env.resources.kmsKeys.length})
                      </Typography>
                      <List dense>
                        {env.resources.kmsKeys.map((key, i) => (
                          <ListItem key={i}>
                            <ListItemText
                              primary={key.keyArn}
                              primaryTypographyProps={{
                                variant: 'body2',
                                sx: { wordBreak: 'break-all' },
                              }}
                            />
                            <IconButton
                              size="small"
                              onClick={() => handleCopy(key.keyArn)}
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}
                  {env.resources.lambdaFunctions.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="subtitle2"
                        color="primary"
                        gutterBottom
                      >
                        Lambda Functions ({env.resources.lambdaFunctions.length}
                        )
                      </Typography>
                      <List dense>
                        {env.resources.lambdaFunctions.map((func, i) => (
                          <ListItem key={i}>
                            <ListItemText
                              primary={func.functionArn}
                              primaryTypographyProps={{
                                variant: 'body2',
                                sx: { wordBreak: 'break-all' },
                              }}
                            />
                            <IconButton
                              size="small"
                              onClick={() => handleCopy(func.functionArn)}
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}
                </Box>
              </Box>
            ))}
          </Paper>

          {/* Submitted By */}
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Submission Details
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Submitted By
                </Typography>
                <Typography variant="body1">
                  {request.requestedBy.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {request.requestedBy.email}
                </Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Created Date
                </Typography>
                <Typography variant="body1">
                  {new Date(request.createdAt).toLocaleString()}
                </Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Last Updated
                </Typography>
                <Typography variant="body1">
                  {new Date(request.updatedAt).toLocaleString()}
                </Typography>
              </Grid>
            </Grid>
          </Paper>
        </Grid>

        {/* Sidebar */}
        <Grid item xs={12} md={4}>
          {/* Status Timeline */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Status Timeline
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Timeline items={timelineItems} />
          </Paper>

          {/* Comments */}
          {request.comments.length > 0 && (
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom>
                Comments
              </Typography>
              <Divider sx={{ mb: 2 }} />
              {request.comments.map((comment) => (
                <Box key={comment.id} sx={{ mb: 2 }}>
                  <Typography variant="body2" fontWeight="bold">
                    {comment.author}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {new Date(comment.timestamp).toLocaleString()}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {comment.content}
                  </Typography>
                </Box>
              ))}
            </Paper>
          )}
        </Grid>
      </Grid>
    </Container>
  );
}
