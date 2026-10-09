import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import SearchIcon from '@mui/icons-material/Search';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { useAuth } from '@/auth';
import { buildQnaDetailsPath } from '@/config';
import { qnaService } from '@/api/services';
import { fuzzySearch, formatDateTime } from '@/utils';
import type { QnaQuestionSummary } from '@/types/qna.types';

type StatusFilter = 'ALL' | 'ANSWERED' | 'OPEN';

const TITLE_MIN = 5;
const TITLE_MAX = 200;
const BODY_MIN = 10;
const BODY_MAX = 5000;

export function QnaPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [questions, setQuestions] = useState<QnaQuestionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  const [askOpen, setAskOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setQuestions(await qnaService.list());
    } catch (error) {
      console.error('[Q&A] Failed to load questions:', error);
      setLoadError('Could not load questions. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  // Arriving from the Troubleshooting page with the user's description:
  // open the ask dialog with it filled in, then clear the navigation state
  // so a refresh doesn't reopen it.
  useEffect(() => {
    const state = location.state as { prefill?: string } | null;
    if (state?.prefill) {
      setBody(state.prefill.slice(0, BODY_MAX));
      setAskOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  const visibleQuestions = useMemo(() => {
    const byStatus =
      statusFilter === 'ALL' ? questions : questions.filter((q) => q.status === statusFilter);
    if (search.trim().length < 2) return byStatus;
    return fuzzySearch(
      search,
      byStatus,
      (q) => [
        { text: q.title, weight: 3 },
        { text: q.answerPreview ?? '', weight: 1.5 },
        { text: q.body, weight: 1.5 },
      ],
      { minScore: 0.3, limit: 100 }
    ).map((result) => result.item);
  }, [questions, search, statusFilter]);

  // While writing a new question, surface already-answered ones that look
  // like it - this is what makes past answers get reused.
  const similarAnswered = useMemo(() => {
    if (!askOpen || title.trim().length < 4) return [];
    return fuzzySearch(
      title,
      questions.filter((q) => q.status === 'ANSWERED'),
      (q) => [
        { text: q.title, weight: 3 },
        { text: q.answerPreview ?? '', weight: 1.5 },
        { text: q.body, weight: 1 },
      ],
      { limit: 3 }
    ).map((result) => result.item);
  }, [askOpen, questions, title]);

  const closeAskDialog = () => {
    if (submitting) return;
    setAskOpen(false);
    setSubmitError(null);
  };

  const titleValid = title.trim().length >= TITLE_MIN && title.trim().length <= TITLE_MAX;
  const bodyValid = body.trim().length >= BODY_MIN && body.trim().length <= BODY_MAX;

  const handleSubmit = async () => {
    if (!user || !titleValid || !bodyValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await qnaService.ask(
        { title: title.trim(), body: body.trim() },
        { id: user.id, name: user.name, email: user.email }
      );
      setAskOpen(false);
      setTitle('');
      setBody('');
      navigate(buildQnaDetailsPath(created.questionId));
    } catch (error) {
      console.error('[Q&A] Failed to post question:', error);
      setSubmitError('Could not post your question. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight="bold" gutterBottom>
            Q&amp;A
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Ask a question and an admin will respond. Answers stay here so the
            next person can find them.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<ForumOutlinedIcon />}
          onClick={() => setAskOpen(true)}
        >
          Ask a question
        </Button>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
        <TextField
          fullWidth
          size="small"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search questions and answers"
          inputProps={{ 'aria-label': 'Search questions and answers' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Stack direction="row" spacing={1} alignItems="center">
          {(['ALL', 'ANSWERED', 'OPEN'] as const).map((value) => (
            <Chip
              key={value}
              label={value === 'ALL' ? 'All' : value === 'ANSWERED' ? 'Answered' : 'Open'}
              color={statusFilter === value ? 'primary' : 'default'}
              variant={statusFilter === value ? 'filled' : 'outlined'}
              onClick={() => setStatusFilter(value)}
            />
          ))}
        </Stack>
      </Stack>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && loadError && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void loadQuestions()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {!loading && !loadError && visibleQuestions.length === 0 && (
        <Alert severity="info">
          {questions.length === 0
            ? 'No questions yet. Be the first to ask one.'
            : 'No questions match your search or filter.'}
        </Alert>
      )}

      {!loading && !loadError && (
        <Stack spacing={1.5}>
          {visibleQuestions.map((question) => (
            <Card key={question.questionId} variant="outlined">
              <CardActionArea onClick={() => navigate(buildQnaDetailsPath(question.questionId))}>
                <CardContent>
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: 2,
                      mb: 0.5,
                    }}
                  >
                    <Typography variant="subtitle1" fontWeight="bold">
                      {question.title}
                    </Typography>
                    <Chip
                      label={question.status === 'ANSWERED' ? 'Answered' : 'Open'}
                      size="small"
                      color={question.status === 'ANSWERED' ? 'success' : 'default'}
                      variant={question.status === 'ANSWERED' ? 'filled' : 'outlined'}
                      sx={{ flexShrink: 0 }}
                    />
                  </Box>
                  {question.answerPreview && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        mb: 1,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {question.answerPreview}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'text.secondary' }}>
                    <Typography variant="caption">
                      {question.askedByName} · {formatDateTime(question.createdAt)}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <ChatBubbleOutlineIcon sx={{ fontSize: 14 }} />
                      <Typography variant="caption">{question.commentCount}</Typography>
                    </Box>
                  </Box>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      )}

      <Dialog open={askOpen} onClose={closeAskDialog} fullWidth maxWidth="sm">
        <DialogTitle>Ask a question</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Title"
              fullWidth
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              error={title.length > 0 && !titleValid}
              helperText={
                title.length > 0 && !titleValid
                  ? `Between ${TITLE_MIN} and ${TITLE_MAX} characters`
                  : 'A short summary of what you need'
              }
              inputProps={{ maxLength: TITLE_MAX }}
            />
            {similarAnswered.length > 0 && (
              <Alert severity="info" icon={false}>
                <Typography variant="body2" fontWeight={500} gutterBottom>
                  Already answered? These look similar:
                </Typography>
                {similarAnswered.map((question) => (
                  <Box key={question.questionId}>
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      variant="body2"
                      sx={{ textAlign: 'left' }}
                      onClick={() => navigate(buildQnaDetailsPath(question.questionId))}
                    >
                      {question.title}
                    </Link>
                  </Box>
                ))}
              </Alert>
            )}
            <TextField
              label="Details"
              fullWidth
              multiline
              minRows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              error={body.length > 0 && !bodyValid}
              helperText={
                body.length > 0 && !bodyValid
                  ? `Between ${BODY_MIN} and ${BODY_MAX} characters`
                  : 'Include the request ID, market and any error text you see'
              }
              inputProps={{ maxLength: BODY_MAX }}
            />
            <Typography variant="caption" color="text.secondary">
              Admins are emailed when you post. Your name is shown on the question;
              your email address is not.
            </Typography>
            {submitError && <Alert severity="error">{submitError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAskDialog} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSubmit()}
            disabled={submitting || !titleValid || !bodyValid || !user}
          >
            {submitting ? 'Posting…' : 'Post question'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
