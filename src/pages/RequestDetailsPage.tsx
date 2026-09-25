import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Container,
  Typography,
  Button,
  Grid,
  Paper,
  IconButton,
  Divider,
  List,
  ListItem,
  ListItemText,
  Link,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CancelIcon from '@mui/icons-material/Cancel';
import { Timeline, Loader, ErrorState, StatusChip, AgentRoleArn, PolicyPreviewButton } from '@/components/common';
import { config } from '@/config';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import {
  RequestDetails,
  getUserFacingStatus,
  USER_FACING_STATUS_CONFIG,
  isRequestCancellable,
} from '@/types/request.types';
import { RESOURCE_TYPE_META } from '@/constants/resourceTypes';
import { UserRole } from '@/types/auth.types';

export function RequestDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, hasRole } = useAuth();
  const [request, setRequest] = useState<RequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  // Captured once from router state on arrival (e.g. redirected here right
  // after submitting a new request) and then cleared from history so it
  // does not reappear on a refresh or a back/forward navigation.
  const [justSubmittedMessage] = useState<string | null>(
    () => (location.state as { success?: string } | null)?.success ?? null
  );

  useEffect(() => {
    if (justSubmittedMessage) {
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelState, setCancelState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });

  const closeCancelDialog = () => {
    if (cancelState.loading) return; // don't let a stray close interrupt an in-flight submit
    setCancelDialogOpen(false);
    setCancelReason('');
    setCancelState({ loading: false, error: null });
  };

  const handleCancelRequest = async () => {
    if (!id || !user?.id) return;
    setCancelState({ loading: true, error: null });
    try {
      await requestService.cancelRequest(id, user.id, cancelReason.trim() || undefined);
      setCancelDialogOpen(false);
      setCancelReason('');
      setCancelState({ loading: false, error: null });
      const refreshed = await requestService.getRequestById(id, user.id);
      setRequest(refreshed);
    } catch (error) {
      setCancelState({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to cancel the request',
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

  // The timeline shows the same collapsed, user-facing status (Pending /
  // In Progress / Completed) as every other badge on this page - not the
  // raw Git/workflow status (PR_APPROVED, SYNC_FAILED, etc.) - so it never
  // exposes backend machinery the way the old granular labels did.
  const TIMELINE_COLOR_BY_USER_FACING_STATUS: Record<
    ReturnType<typeof getUserFacingStatus>,
    'grey' | 'info' | 'primary'
  > = {
    PENDING: 'grey',
    IN_PROGRESS: 'info',
    COMPLETED: 'primary',
  };

  // A request that goes through DEV then QA then PRD produces several raw
  // history entries that all collapse to the same user-facing status (e.g.
  // PR_CREATED/PR_APPROVED/COMPLETED on dev, then again on qa) - showing
  // one "In Progress" timeline entry per stage read as duplicates once the
  // label no longer says which stage it was. Consecutive entries that
  // collapse to the same status are merged into a single timeline item
  // instead, spanning from when that phase started to its last update, so
  // the timeline shows at most one Pending, one In Progress and one
  // Completed entry (never one per environment).
  const historyGroups: { userFacingStatus: ReturnType<typeof getUserFacingStatus>; entries: typeof request.history }[] = [];
  for (const entry of request.history) {
    const userFacingStatus = getUserFacingStatus(entry.status);
    const currentGroup = historyGroups[historyGroups.length - 1];
    if (currentGroup && currentGroup.userFacingStatus === userFacingStatus) {
      currentGroup.entries.push(entry);
    } else {
      historyGroups.push({ userFacingStatus, entries: [entry] });
    }
  }

  const timelineItems: {
    id: string;
    title: string;
    description: string;
    date: string;
    color: 'grey' | 'info' | 'primary';
  }[] = [];
  historyGroups.forEach((group, index) => {
    const { userFacingStatus, entries } = group;
    const firstEntry = entries[0];
    const lastEntry = entries[entries.length - 1];
    // historyGroups only ever pushes groups with at least one entry (see
    // the loop above), so this is unreachable - the guard is here purely
    // so TS can narrow entries[0]/entries[entries.length - 1] past
    // 'possibly undefined' without a non-null assertion.
    if (!firstEntry || !lastEntry) return;

    const label = USER_FACING_STATUS_CONFIG[userFacingStatus].label;
    const timelineColor = TIMELINE_COLOR_BY_USER_FACING_STATUS[userFacingStatus];
    const performedBy = lastEntry.performedBy || 'System';

    timelineItems.push({
      id: `${userFacingStatus}-${index}-${firstEntry.timestamp}`,
      title: label,
      // Deliberately no per-environment (DEV/QA/PRD) breakdown here - a
      // single 'In Progress' group can span all three as the request is
      // promoted automatically, and surfacing just the stage(s) reached
      // so far reads as more complete/final than it is, which confused
      // users into thinking the request had stalled on one environment.
      description: `By ${performedBy}`,
      date:
        firstEntry.timestamp === lastEntry.timestamp
          ? new Date(firstEntry.timestamp).toLocaleString()
          : `${new Date(firstEntry.timestamp).toLocaleString()} – ${new Date(lastEntry.timestamp).toLocaleString()}`,
      color: timelineColor,
    });
  });

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {justSubmittedMessage && (
        <Alert severity="success" sx={{ mb: 3 }}>
          {justSubmittedMessage}
        </Alert>
      )}
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
          {isRequestCancellable(request.status) && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<CancelIcon />}
              onClick={() => setCancelDialogOpen(true)}
            >
              Cancel Request
            </Button>
          )}
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
                  <StatusChip status={getUserFacingStatus(request.status)} />
                </Box>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Market Code
                </Typography>
                <Typography variant="body1">
                  {request.marketCode.toUpperCase()}
                </Typography>
              </Grid>
              <Grid item xs={6}>
                <Typography variant="caption" color="text.secondary">
                  Market Name
                </Typography>
                <Typography variant="body1">{request.marketName}</Typography>
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
            {(() => {
              const S3Icon = RESOURCE_TYPE_META.s3Buckets.icon;
              const SecretsIcon = RESOURCE_TYPE_META.secretsManager.icon;
              const KmsIcon = RESOURCE_TYPE_META.kmsKeys.icon;
              const LambdaIcon = RESOURCE_TYPE_META.lambdaFunctions.icon;
              return request.environments.map((env, idx) => (
              <Box key={idx} sx={{ mb: 3 }}>
                <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
                  {env.environment} Environment
                </Typography>
                <AgentRoleArn environment={env.environment} marketCode={request.marketCode} />
                {/* A policy preview shows what access would be GRANTED - meaningless
                    (and misleading) for a de-whitelist request, which only removes
                    access. Mirrors the same requestMode-gating already on Create
                    Request (see PolicyPreviewButton usage there). */}
                {request.requestType !== 'DEWHITELIST' && (
                  <Box sx={{ mb: 2 }}>
                    <PolicyPreviewButton
                      resources={{
                        s3Buckets: env.resources.s3Buckets.map((b) => b.bucketName),
                        secretsManager: env.resources.secretsManager.map((s2) => s2.secretArn),
                        kmsKeys: env.resources.kmsKeys.map((k) => k.keyArn),
                        lambdaFunctions: env.resources.lambdaFunctions.map((f) => f.functionArn),
                      }}
                    />
                  </Box>
                )}
                <Box sx={{ pl: 2 }}>
                  {env.resources.s3Buckets.length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography
                        variant="subtitle2"
                        gutterBottom
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          color: RESOURCE_TYPE_META.s3Buckets.color,
                        }}
                      >
                        <S3Icon fontSize="small" />
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
                        gutterBottom
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          color: RESOURCE_TYPE_META.secretsManager.color,
                        }}
                      >
                        <SecretsIcon fontSize="small" />
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
                        gutterBottom
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          color: RESOURCE_TYPE_META.kmsKeys.color,
                        }}
                      >
                        <KmsIcon fontSize="small" />
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
                        gutterBottom
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.75,
                          color: RESOURCE_TYPE_META.lambdaFunctions.color,
                        }}
                      >
                        <LambdaIcon fontSize="small" />
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
              ));
            })()}
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
          {/* AWS verification notice - the git side (PR merge) is done, but
              this Lambda hasn't yet confirmed the change is actually live
              in the target AWS account's IAM policy. handle_validation_sweep
              (an EventBridge sweep) checks this automatically every ~10
              minutes and flips the request to COMPLETED once confirmed -
              see the AWS-SIDE ACCESS VERIFICATION block in lambda/handler.py.
              No action needed here; this is purely informational. */}
          {request.status === 'PENDING_AWS_VERIFICATION' && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Alert severity="warning">
                The pull request has merged, but this request stays open
                until we&apos;ve confirmed the change is actually live in
                AWS - this is checked automatically every few minutes.
                {typeof request.verificationAttempts === 'number' && request.verificationAttempts > 0
                  ? ` Checked ${request.verificationAttempts} time${request.verificationAttempts === 1 ? '' : 's'} so far.`
                  : ''}
              </Alert>
            </Paper>
          )}

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

      <Dialog open={cancelDialogOpen} onClose={closeCancelDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Cancel Request</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This cancels {request.requestId} before it&apos;s merged to DEV - no branch or pull
            request will be left behind. This can&apos;t be undone.
          </Alert>
          <TextField
            label="Reason (optional)"
            placeholder="Why is this being cancelled?"
            multiline
            minRows={2}
            fullWidth
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            disabled={cancelState.loading}
          />
          {cancelState.error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {cancelState.error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeCancelDialog} disabled={cancelState.loading}>
            Keep Request
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void handleCancelRequest()}
            disabled={cancelState.loading}
          >
            {cancelState.loading ? 'Cancelling…' : 'Cancel Request'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
