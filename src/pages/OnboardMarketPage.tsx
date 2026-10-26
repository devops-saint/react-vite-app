import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddBusinessOutlinedIcon from '@mui/icons-material/AddBusinessOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { isAxiosError } from 'axios';
import { useAuth } from '@/auth';
import { marketService } from '@/api/services';
import type { OnboardMarketResult } from '@/api/services';
import { invalidateMarketsCache, useMarkets } from '@/hooks';
import { UserRole } from '@/types/auth.types';

// Same rule the backend enforces (and the folder name in the repo).
const MARKET_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const VALUES_FILES = ['values.yaml', 'values.dev.yaml', 'values.qa.yaml', 'values.prd.yaml'];

function errorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const data: unknown = error.response?.data;
    const body: unknown = typeof data === 'string' ? safeParse(data) : data;
    if (body && typeof body === 'object') {
      const message = (body as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message) return message;
    }
  }
  return 'Could not onboard the market. Please try again.';
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function OnboardMarketPage() {
  const { user, hasRole, accessStatus, canMutate } = useAuth();
  const { markets, loading: marketsLoading, fallback, reload } = useMarkets();

  const [code, setCode] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardMarketResult | null>(null);

  const isAdmin = hasRole(UserRole.ADMIN);
  const trimmed = code.trim();
  const folder = trimmed.toLowerCase();
  const formatValid = MARKET_CODE_PATTERN.test(trimmed);
  const alreadyExists = markets.some((item) => item.code.toLowerCase() === folder);
  const codeError =
    trimmed && !formatValid
      ? 'Use 1-32 letters, digits, "-" or "_", starting with a letter or digit.'
      : alreadyExists
        ? `${trimmed.toUpperCase()} already exists in the repository.`
        : '';
  const canSubmit =
    isAdmin && canMutate && formatValid && !alreadyExists && !marketsLoading && !fallback && !submitting;

  if (accessStatus === 'loading' || accessStatus === 'idle') {
    return (
      <Container maxWidth="md" sx={{ py: 4, textAlign: 'center' }}>
        <CircularProgress aria-label="Checking your access" />
      </Container>
    );
  }

  if (!isAdmin) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Alert severity="warning">Only portal admins can onboard a new market.</Alert>
      </Container>
    );
  }

  const submit = async () => {
    setConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await marketService.onboardMarket(folder, user?.email ?? '');
      setResult(outcome);
      setCode('');
      invalidateMarketsCache();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5 }}>
        <AddBusinessOutlinedIcon color="primary" />
        <Typography variant="h4" fontWeight="bold">
          Onboard a market
        </Typography>
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Adds a new market folder to the config repository so people can request access for it.
      </Typography>

      {accessStatus === 'error' && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Your access permissions couldn&apos;t be verified, so onboarding is disabled right
          now. Refresh to try again.
        </Alert>
      )}
      {fallback && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Couldn&apos;t read the current market list from the repository, so onboarding is
          disabled until it can be checked (it would otherwise be unable to tell whether the
          market already exists).{' '}
          <Link component="button" type="button" onClick={reload} sx={{ verticalAlign: 'baseline' }}>
            Retry
          </Link>
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2.5 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {result && (
        <Alert severity="success" sx={{ mb: 2.5 }} onClose={() => setResult(null)}>
          <Typography variant="body2" fontWeight={600}>
            Pull requests opened for {result.marketCode}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            The market appears in the portal once the dev pull request is merged. Merge qa and
            master too, or requests for {result.marketCode} will fail when promoted there.
          </Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
            {result.pullRequests.map((pr) => (
              <li key={pr.branch}>
                {pr.prUrl ? (
                  <Link href={pr.prUrl} target="_blank" rel="noopener noreferrer">
                    {pr.branch}{' '}
                    <OpenInNewIcon sx={{ fontSize: 14, verticalAlign: 'text-bottom' }} />
                  </Link>
                ) : (
                  pr.branch
                )}
              </li>
            ))}
          </Stack>
          {result.alreadyPresentOn.length > 0 && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Already present on {result.alreadyPresentOn.join(', ')} - no pull request needed
              there.
            </Typography>
          )}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, mb: 3 }}>
        <TextField
          fullWidth
          required
          label="Market code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={Boolean(codeError)}
          helperText={codeError || 'The folder name in the repository, e.g. DE or UK.'}
          disabled={submitting}
          inputProps={{ maxLength: 32 }}
        />

        <Typography variant="subtitle2" sx={{ mt: 2.5, mb: 0.5 }}>
          What will be created
        </Typography>
        <Typography variant="body2" color="text.secondary">
          A pull request into each of dev, qa and master, each adding:
        </Typography>
        <Box component="ul" sx={{ mt: 0.5, mb: 0, pl: 2.5, fontFamily: 'monospace', fontSize: 13 }}>
          {VALUES_FILES.map((file) => (
            <li key={file}>
              {folder || '<market>'}/{file}
            </li>
          ))}
        </Box>

        <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="contained"
            disabled={!canSubmit}
            onClick={() => setConfirmOpen(true)}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {submitting ? 'Creating pull requests...' : 'Onboard market'}
          </Button>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Markets in the repository {marketsLoading ? '' : `(${markets.length})`}
        </Typography>
        {marketsLoading ? (
          <CircularProgress size={20} aria-label="Loading markets" />
        ) : markets.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            None found.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {markets.map((item) => (
              <Chip key={item.code} size="small" label={item.code} />
            ))}
          </Box>
        )}
      </Paper>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Onboard {trimmed.toUpperCase()}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This opens three pull requests (dev, qa, master) in the config repository and
            emails the approvers. Nothing is merged until they are reviewed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => void submit()}>
            Open pull requests
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
