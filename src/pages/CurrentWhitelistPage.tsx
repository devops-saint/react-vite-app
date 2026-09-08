import { useEffect, useState } from 'react';
import {
  Container,
  Typography,
  Paper,
  Box,
  Divider,
  Grid,
  TextField,
  MenuItem,
  IconButton,
  Chip,
  Alert,
  Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { Loader, ErrorState } from '@/components/common';
import { config } from '@/config';
import { requestService } from '@/api/services';
import { CurrentWhitelist } from '@/types/request.types';

const ENVIRONMENTS = ['DEV', 'QA', 'PRD'] as const;

const SECTIONS: { key: keyof Pick<CurrentWhitelist, 'buckets' | 'secrets' | 'kmsKeys' | 'functions'>; label: string }[] = [
  { key: 'buckets', label: 'S3 Buckets' },
  { key: 'secrets', label: 'Secrets Manager' },
  { key: 'kmsKeys', label: 'KMS Keys' },
  { key: 'functions', label: 'Lambda Functions' },
];

export function CurrentWhitelistPage() {
  // Neither starts pre-selected - showing a default market/DEV on load
  // reads as "here's DEV's whitelist" before the viewer has chosen
  // anything, which is misleading when they meant a different market.
  // Require an explicit choice for both instead.
  const [marketCode, setMarketCode] = useState('');
  const [environment, setEnvironment] = useState<'' | (typeof ENVIRONMENTS)[number]>('');
  const [whitelist, setWhitelist] = useState<CurrentWhitelist | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWhitelist = async () => {
    if (!marketCode || !environment) return;
    setLoading(true);
    setError(null);
    try {
      const data = await requestService.getCurrentWhitelist(marketCode, environment);
      setWhitelist(data);
    } catch (err) {
      console.error('[CurrentWhitelistPage] Failed to fetch whitelist:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to fetch the current whitelist'
      );
      setWhitelist(null);
    } finally {
      setLoading(false);
    }
  };

  // Auto-loads once both a market and an environment are selected (the
  // fetchWhitelist guard above is a no-op until then) - no separate
  // "Search" button needed, but also nothing fetched on the viewer's
  // behalf before they've actually picked something.
  useEffect(() => {
    void fetchWhitelist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketCode, environment]);

  const readyToShow = Boolean(marketCode && environment);

  const market = config.markets.find((item) => item.code === marketCode);

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Inventory2Icon color="primary" />
        <Typography variant="h4" fontWeight="bold">
          Current Whitelist
        </Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        What's already whitelisted for a market and environment, read live from the
        source-controlled config repo - not from requests submitted through this portal.
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'minmax(220px, 0.5fr) minmax(160px, 0.3fr) auto' },
            gap: 2,
            alignItems: 'center',
          }}
        >
          <TextField
            select
            label="Market"
            value={marketCode}
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
            onChange={(event) => setMarketCode(event.target.value)}
          >
            <MenuItem value="">
              <em>Select market</em>
            </MenuItem>
            {config.markets.map((item) => (
              <MenuItem key={item.code} value={item.code}>
                {item.code} — {item.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Environment"
            value={environment}
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
            onChange={(event) =>
              setEnvironment(event.target.value as '' | (typeof ENVIRONMENTS)[number])
            }
          >
            <MenuItem value="">
              <em>Select environment</em>
            </MenuItem>
            {ENVIRONMENTS.map((env) => (
              <MenuItem key={env} value={env}>
                {env}
              </MenuItem>
            ))}
          </TextField>
          <Tooltip title="Refresh">
            <span>
              <IconButton onClick={() => void fetchWhitelist()} disabled={loading}>
                <RefreshIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Paper>

      {!readyToShow && !loading && (
        <Alert severity="info">
          Select a market and an environment above to see the current whitelist.
        </Alert>
      )}

      {loading && <Loader message="Reading current whitelist..." />}

      {!loading && error && (
        <ErrorState
          title="Couldn't load the current whitelist"
          message={error}
          onRetry={() => void fetchWhitelist()}
        />
      )}

      {!loading && !error && whitelist && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, fontFamily: 'monospace' }}>
            {whitelist.filePath}
          </Typography>

          {!whitelist.exists ? (
            <Alert severity="info">
              Nothing has been whitelisted for {market?.code || whitelist.marketCode} in{' '}
              {whitelist.environment} yet - this environment's config file doesn't exist in the
              repo yet.
            </Alert>
          ) : (
            <Grid container spacing={2}>
              {SECTIONS.map((section) => {
                const items = whitelist[section.key];
                return (
                  <Grid item xs={12} sm={6} key={section.key}>
                    <Paper sx={{ p: 3, height: '100%' }}>
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          mb: 1,
                        }}
                      >
                        <Typography variant="h6" fontWeight="bold">
                          {section.label}
                        </Typography>
                        <Chip size="small" label={items.length} />
                      </Box>
                      <Divider sx={{ mb: 2 }} />
                      {items.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          None whitelisted in this environment yet.
                        </Typography>
                      ) : (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {items.map((value) => (
                            <Chip
                              key={value}
                              label={value}
                              size="small"
                              variant="outlined"
                              sx={{ fontFamily: 'monospace', maxWidth: '100%' }}
                            />
                          ))}
                        </Box>
                      )}
                    </Paper>
                  </Grid>
                );
              })}
            </Grid>
          )}
        </>
      )}
    </Container>
  );
}
