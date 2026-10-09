import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import { useAuth } from '@/auth';
import { config } from '@/config';
import { qnaService } from '@/api/services';
import { formatDateTime } from '@/utils';
import type { QnaQuestionDetail } from '@/types/qna.types';

const COMMENT_MAX = 5000;

export function QnaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [question, setQuestion] = useState<QnaQuestionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      setQuestion(await qnaService.get(id));
    } catch (error) {
      console.error('[Q&A] Failed to load thread:', error);
      setLoadError('Could not load this question. It may have been removed.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const replyValid = reply.trim().length > 0 && reply.trim().length <= COMMENT_MAX;

  const handlePost = async () => {
    if (!id || !user || !replyValid) return;
    setPosting(true);
    setPostError(null);
    try {
      // The backend decides whether this author is an admin (and so
      // whether the question becomes Answered) - the client only reports
      // who is posting.
      const updated = await qnaService.addComment(id, reply.trim(), {
        id: user.id,
        name: user.name,
        email: user.email,
      });
      setQuestion(updated);
      setReply('');
    } catch (error) {
      console.error('[Q&A] Failed to post comment:', error);
      setPostError('Could not post your comment. Please try again.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(config.routes.qna)}
        sx={{ mb: 2 }}
      >
        All questions
      </Button>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && loadError && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {!loading && question && (
        <>
          <Paper sx={{ p: 3, mb: 3 }}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 2,
                mb: 1,
              }}
            >
              <Typography variant="h5" fontWeight="bold">
                {question.title}
              </Typography>
              <Chip
                label={question.status === 'ANSWERED' ? 'Answered' : 'Open'}
                color={question.status === 'ANSWERED' ? 'success' : 'default'}
                variant={question.status === 'ANSWERED' ? 'filled' : 'outlined'}
                sx={{ flexShrink: 0 }}
              />
            </Box>
            <Typography variant="caption" color="text.secondary">
              Asked by {question.askedByName} · {formatDateTime(question.createdAt)}
            </Typography>
            <Divider sx={{ my: 2 }} />
            <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {question.body}
            </Typography>
          </Paper>

          <Typography variant="h6" fontWeight="bold" sx={{ mb: 1.5 }}>
            {question.comments.length === 0
              ? 'No responses yet'
              : `${question.comments.length} ${question.comments.length === 1 ? 'response' : 'responses'}`}
          </Typography>
          {question.status === 'OPEN' && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Waiting for an admin to respond. Admins have been notified.
            </Alert>
          )}

          <Stack spacing={1.5} sx={{ mb: 3 }}>
            {question.comments.map((comment) => (
              <Paper
                key={comment.commentId}
                variant="outlined"
                sx={{
                  p: 2,
                  borderColor: comment.isAdmin ? 'primary.main' : undefined,
                  borderWidth: comment.isAdmin ? 2 : 1,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="subtitle2" fontWeight="bold">
                    {comment.authorName}
                  </Typography>
                  {comment.isAdmin && (
                    <Chip
                      icon={<AdminPanelSettingsIcon />}
                      label="Admin"
                      size="small"
                      color="primary"
                    />
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {formatDateTime(comment.createdAt)}
                  </Typography>
                </Box>
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {comment.body}
                </Typography>
              </Paper>
            ))}
          </Stack>

          <Paper sx={{ p: 2.5 }}>
            <TextField
              fullWidth
              multiline
              minRows={3}
              label="Add a comment"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              inputProps={{ maxLength: COMMENT_MAX }}
              disabled={posting}
            />
            {postError && (
              <Alert severity="error" sx={{ mt: 1.5 }}>
                {postError}
              </Alert>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
              <Button
                variant="contained"
                onClick={() => void handlePost()}
                disabled={posting || !replyValid || !user}
              >
                {posting ? 'Posting…' : 'Post comment'}
              </Button>
            </Box>
          </Paper>
        </>
      )}
    </Container>
  );
}
