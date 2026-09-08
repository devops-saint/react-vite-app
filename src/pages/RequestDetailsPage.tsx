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
  Link,
  Alert,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Timeline, Loader, ErrorState } from '@/components/common';
import { config } from '@/config';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import { RequestDetails, getStatusConfig } from '@/types/request.types';
import { UserRole } from '@/types/auth.types';

export function RequestDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, hasRole } = useAuth();
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

  const [releaseState, setReleaseState] = useState<{
    loading: boolean;
    message: string | null;
    error: string | null;
  }>({ loading: false, message: null, error: null });

  const handleReleaseLock = async () => {
    if (!id) return;
    setReleaseState({ loading: true, message: null, error: null });
    try {
      const result = await requestService.releaseMarketLock(id);
      setReleaseState({ loading: false, message: result.message, error: null });
      // Re-fetch: this request may now have been promoted off the queue
      // (if it was the oldest waiting), or may still show QUEUED behind
      // whichever request was next in line.
      if (user?.id) {
        const refreshed = await requestService.getRequestById(id, user.id);
        setRequest(refreshed);
      }
    } catch (error) {
      setReleaseState({
        loading: false,
        message: null,
        error:
          error instanceof Error ? error.message : 'Failed to release market lock',
      });
    }
  };

  const [retryPromotionState, setRetryPromotionState] = useState<{
    loading: boolean;
    message: string | null;
    error: string | null;
  }>({ loading: false, message: null, error: null });

  const handleRetryPromotion = async () => {
    if (!id) return;
    setRetryPromotionState({ loading: true, message: null, error: null });
    try {
      const result = await requestService.retryPromotion(id);
      setRetryPromotionState({ loading: false, message: result.message, error: null });
      // Re-fetch: a fresh promotion PR should now be open for the next
      // stage - the timeline/PR links panel will pick it up.
      if (user?.id) {
        const refreshed = await requestService.getRequestById(id, user.id);
        setRequest(refreshed);
      }
    } catch (error) {
      setRetryPromotionState({
        loading: false,
        message: null,
        error:
          error instanceof Error ? error.message : 'Failed to retry promotion',
      });
    }
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

    const label = getStatusConfig(entry.status).label;
    return {
      id: entry.timestamp,
      // entry.stage (DEV/QA/PRD) disambiguates which branch's PR this
      // entry is about, since PR_APPROVED/PR_CREATED/etc. are reused
      // across every stage.
      title: entry.stage ? `${label} · ${entry.stage}` : label,
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
                  {request.marketCode.toUpperCase()} - {request.marketName}
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
          {/* Queued notice - this request is held back because another
              in-flight request for the same market already holds the
              MARKETLOCK (see lambda/handler.py). It resumes automatically
              once that one reaches a terminal state; admins can force it
              sooner via release-lock if the blocking request is dead. */}
          {request.status === 'QUEUED' && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Alert severity="info" sx={{ mb: hasRole(UserRole.ADMIN) ? 2 : 0 }}>
                This request is queued
                {request.blockedBy ? ` behind ${request.blockedBy}` : ''} for
                market {request.marketCode.toUpperCase()} - it will start automatically
                once that request completes.
              </Alert>
              {hasRole(UserRole.ADMIN) && (
                <>
                  <Button
                    variant="outlined"
                    color="warning"
                    size="small"
                    disabled={releaseState.loading}
                    onClick={() => void handleReleaseLock()}
                  >
                    {releaseState.loading ? 'Releasing…' : 'Force release market lock'}
                  </Button>
                  {releaseState.message && (
                    <Alert severity="success" sx={{ mt: 2 }}>
                      {releaseState.message}
                    </Alert>
                  )}
                  {releaseState.error && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                      {releaseState.error}
                    </Alert>
                  )}
                </>
              )}
            </Paper>
          )}

          {/* Stuck-promotion notice - this request merged into a stage
              (dev/qa) but no PR ever appeared for the next one. Usually
              means the LOCK#{MARKET}#{BRANCH} guarding that promotion
              got orphaned - most often an earlier promotion PR to that
              same branch was resolved outside the portal (closed/merged
              directly in the repo host rather than through the webhook),
              so the lock was never released and silently absorbs every
              later promotion attempt without opening a visible PR. See
              _admin_force_retry_promotion in lambda/handler.py. */}
          {request.status.includes('_MERGED_AWAITING_') && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Alert severity="warning" sx={{ mb: hasRole(UserRole.ADMIN) ? 2 : 0 }}>
                This request merged but no promotion pull request has
                appeared for the next stage yet. If it&apos;s been a while,
                the lock guarding that promotion may be stuck.
              </Alert>
              {hasRole(UserRole.ADMIN) && (
                <>
                  <Button
                    variant="outlined"
                    color="warning"
                    size="small"
                    disabled={retryPromotionState.loading}
                    onClick={() => void handleRetryPromotion()}
                  >
                    {retryPromotionState.loading ? 'Retrying…' : 'Retry promotion'}
                  </Button>
                  {retryPromotionState.message && (
                    <Alert severity="success" sx={{ mt: 2 }}>
                      {retryPromotionState.message}
                    </Alert>
                  )}
                  {retryPromotionState.error && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                      {retryPromotionState.error}
                    </Alert>
                  )}
                </>
              )}
            </Paper>
          )}

          {/* Status Timeline */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Status Timeline
            </Typography>
            <Divider sx={{ mb: 2 }} />
            <Timeline items={timelineItems} />
          </Paper>

          {/* Pull Requests - admin only. Bitbucket URLs are None/absent
              when a stage has no PR yet, so only stages we actually have
              a link for are shown. */}
          {hasRole(UserRole.ADMIN) &&
            request.prUrls &&
            Object.values(request.prUrls).some((url) => url) && (
              <Paper sx={{ p: 3, mb: 3 }}>
                <Typography variant="h6" gutterBottom>
                  Pull Requests
                </Typography>
                <Divider sx={{ mb: 2 }} />
                <List dense disablePadding>
                  {Object.entries(request.prUrls)
                    .filter(([, url]) => url)
                    .map(([stage, url]) => (
                      <ListItem key={stage} disableGutters>
                        <ListItemText
                          primary={
                            <Link
                              href={url as string}
                              target="_blank"
                              rel="noopener noreferrer"
                              sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                            >
                              {stage} pull request
                              <OpenInNewIcon fontSize="inherit" />
                            </Link>
                          }
                        />
                      </ListItem>
                    ))}
                </List>
              </Paper>
            )}

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
