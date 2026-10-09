import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { config, buildQnaDetailsPath } from '@/config';
import { TROUBLESHOOTING_ARTICLES } from '@/constants/troubleshootingArticles';
import { qnaService } from '@/api/services';
import { fuzzySearch } from '@/utils';
import type { QnaQuestionSummary } from '@/types/qna.types';

type SourceKind = 'internal' | 'confluence' | 'matillion' | 'community';

interface KnowledgeEntry {
  id: string;
  title: string;
  summary: string;
  keywords: string;
  source: SourceKind;
  /** External link (Confluence, Matillion, other docs). */
  url?: string;
  /** In-app route. */
  path?: string;
  pathLabel?: string;
  steps?: string[];
}

const SOURCE_LABEL: Record<SourceKind, string> = {
  internal: 'Portal guide',
  confluence: 'Confluence',
  matillion: 'Matillion docs',
  community: 'Answered in Q&A',
};

const MIN_QUERY_LENGTH = 3;
const SEARCH_DEBOUNCE_MS = 250;

export function TroubleshootingPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [answeredQuestions, setAnsweredQuestions] = useState<QnaQuestionSummary[]>([]);
  const [outcome, setOutcome] = useState<'unanswered' | 'solved' | 'unsolved'>('unanswered');
  const [copied, setCopied] = useState(false);

  const { confluencePages, internalDocs, matillionDocs, supportTicketUrl, supportTicketLabel } =
    config.troubleshooting;

  // Questions an admin has already answered in the Q&A forum are searchable
  // too, so an answer given once is found the next time. Best-effort: if
  // the forum can't be reached the page still works from everything else.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const questions = await qnaService.list();
        if (!cancelled) {
          setAnsweredQuestions(questions.filter((q) => q.status === 'ANSWERED'));
        }
      } catch (error) {
        console.warn('[Troubleshooting] Could not load answered Q&A threads:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // A new description starts a fresh "did this help?" round.
  useEffect(() => {
    setOutcome('unanswered');
  }, [debouncedQuery]);

  const entries = useMemo<KnowledgeEntry[]>(() => {
    const fromLinks = (
      links: typeof confluencePages,
      source: SourceKind,
      idPrefix: string
    ): KnowledgeEntry[] =>
      links.map((link, index) => ({
        id: `${idPrefix}-${index}`,
        title: link.title,
        summary: link.summary,
        keywords: link.keywords,
        source,
        url: link.url,
      }));

    return [
      ...TROUBLESHOOTING_ARTICLES.map<KnowledgeEntry>((article) => ({
        id: `article-${article.id}`,
        title: article.title,
        summary: article.summary,
        keywords: article.keywords,
        source: 'internal',
        path: article.path,
        pathLabel: article.pathLabel,
        steps: article.steps,
      })),
      ...fromLinks(internalDocs, 'internal', 'internal-doc'),
      ...fromLinks(confluencePages, 'confluence', 'confluence'),
      ...fromLinks(matillionDocs, 'matillion', 'matillion'),
      ...answeredQuestions.map<KnowledgeEntry>((question) => ({
        id: `qna-${question.questionId}`,
        title: question.title,
        summary: question.answerPreview ?? '',
        keywords: question.body.slice(0, 500),
        source: 'community',
        path: buildQnaDetailsPath(question.questionId),
        pathLabel: 'View the full answer',
      })),
    ];
  }, [answeredQuestions, confluencePages, internalDocs, matillionDocs]);

  const trimmedQuery = debouncedQuery.trim();
  const hasQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;
  const results = useMemo(
    () =>
      hasQuery
        ? fuzzySearch(
            trimmedQuery,
            entries,
            (entry) => [
              { text: entry.title, weight: 3 },
              { text: entry.keywords, weight: 2 },
              { text: entry.summary, weight: 1.5 },
              { text: entry.steps?.join(' ') ?? '', weight: 1 },
            ],
            { limit: 8 }
          )
        : [],
    [entries, hasQuery, trimmedQuery]
  );

  const showEscalation = hasQuery && (results.length === 0 || outcome === 'unsolved');

  const handleCopyDescription = async () => {
    try {
      await navigator.clipboard.writeText(query.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context / denied) - the text is
      // still in the box for the user to copy by hand.
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Troubleshooting
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Describe the problem in your own words and we&apos;ll suggest guides,
        Confluence pages and documentation that may solve it.
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <BuildCircleOutlinedIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            What&apos;s going wrong?
          </Typography>
        </Box>
        <TextField
          fullWidth
          multiline
          minRows={3}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. my request has been stuck in queue for two days"
          inputProps={{ 'aria-label': 'Describe your issue' }}
          helperText="A sentence or two is enough. Mention any status or error text you see."
        />
      </Paper>

      {hasQuery && results.length > 0 && (
        <Stack spacing={2} sx={{ mb: 3 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            Suggested solutions
          </Typography>
          {results.map(({ item }) => (
            <Paper key={item.id} sx={{ p: 2.5 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 2,
                  mb: 0.5,
                }}
              >
                <Typography variant="subtitle1" fontWeight="bold">
                  {item.title}
                </Typography>
                <Chip
                  label={SOURCE_LABEL[item.source]}
                  size="small"
                  variant="outlined"
                  color="primary"
                  sx={{ flexShrink: 0 }}
                />
              </Box>
              {item.summary && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {item.summary}
                </Typography>
              )}
              {item.steps && item.steps.length > 0 && (
                <Accordion disableGutters variant="outlined" sx={{ mb: 1.5 }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant="body2" fontWeight={500}>
                      Show the steps
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
                      {item.steps.map((step) => (
                        <Typography component="li" variant="body2" key={step} sx={{ mb: 0.75 }}>
                          {step}
                        </Typography>
                      ))}
                    </Box>
                  </AccordionDetails>
                </Accordion>
              )}
              {item.url && (
                <Link
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                >
                  Open {SOURCE_LABEL[item.source]} page
                  <OpenInNewIcon fontSize="inherit" />
                </Link>
              )}
              {item.path && (
                <Button size="small" onClick={() => navigate(item.path as string)}>
                  {item.pathLabel ?? 'Open'}
                </Button>
              )}
            </Paper>
          ))}

          {outcome === 'unanswered' && (
            <Paper variant="outlined" sx={{ p: 2.5 }}>
              <Typography variant="body1" fontWeight={500} gutterBottom>
                Did this solve your issue?
              </Typography>
              <Stack direction="row" spacing={1.5}>
                <Button variant="contained" onClick={() => setOutcome('solved')}>
                  Yes, solved
                </Button>
                <Button variant="outlined" onClick={() => setOutcome('unsolved')}>
                  No, still stuck
                </Button>
              </Stack>
            </Paper>
          )}
          {outcome === 'solved' && (
            <Alert severity="success">
              Glad that helped. Search again any time something else comes up.
            </Alert>
          )}
        </Stack>
      )}

      {hasQuery && results.length === 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Nothing matched closely. Try different words, or use one of the options
          below to get help from a person.
        </Alert>
      )}

      {showEscalation && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" fontWeight="bold" gutterBottom>
            Still need help?
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Stack spacing={2}>
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Ask in the Q&amp;A forum. Admins are notified, and the answer stays
                searchable for the next person.
              </Typography>
              <Button
                variant="outlined"
                startIcon={<ForumOutlinedIcon />}
                onClick={() =>
                  navigate(config.routes.qna, { state: { prefill: query.trim() } })
                }
              >
                Ask in Q&amp;A
              </Button>
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Or raise a support request. Copy your description first so you can
                paste it into the ticket.
              </Typography>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <Button
                  variant="outlined"
                  startIcon={<ContentCopyIcon />}
                  onClick={() => void handleCopyDescription()}
                >
                  {copied ? 'Copied' : 'Copy my description'}
                </Button>
                {supportTicketUrl ? (
                  <Button
                    variant="contained"
                    startIcon={<SupportAgentIcon />}
                    component="a"
                    href={supportTicketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Raise a ticket: {supportTicketLabel}
                  </Button>
                ) : (
                  <Alert severity="warning" sx={{ py: 0 }}>
                    The support ticket portal link isn&apos;t configured
                    (VITE_SUPPORT_TICKET_URL).
                  </Alert>
                )}
              </Stack>
            </Box>
          </Stack>
        </Paper>
      )}
    </Container>
  );
}
