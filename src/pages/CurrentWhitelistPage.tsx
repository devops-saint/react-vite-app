import { useEffect, useState, useCallback } from 'react';
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
  Tabs,
  Tab,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import RefreshIcon from '@mui/icons-material/Refresh';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { Loader, ErrorState, AgentRoleArn } from '@/components/common';
import { config } from '@/config';
import { requestService } from '@/api/services';
import { CurrentWhitelist } from '@/types/request.types';
import { RESOURCE_TYPES, RESOURCE_TYPE_META } from '@/constants/resourceTypes';

const ENVIRONMENTS = ['DEV', 'QA', 'PRD'] as const;
type EnvName = (typeof ENVIRONMENTS)[number];

type EnvState = {
  loading: boolean;
  error: string | null;
  data: CurrentWhitelist | null;
};

const EMPTY_ENV_STATE: EnvState = { loading: false, error: null, data: null };

export function CurrentWhitelistPage() {
  // Market still requires an explicit choice - showing a default market on
  // load would read as "here's this market's whitelist" before the viewer
  // has chosen anything. Environment no longer needs a dropdown: once a
  // market is picked, all three environments load together (see fetchAll
  // below), so the Tabs below just switch which already-loaded environment
  // is shown - no re-fetch, no repeated selection.
  const [marketCode, setMarketCode] = useState('');
  const [envState, setEnvState] = useState<Record<EnvName, EnvState>>({
    DEV: EMPTY_ENV_STATE,
    QA: EMPTY_ENV_STATE,
    PRD: EMPTY_ENV_STATE,
  });
  const [activeTab, setActiveTab] = useState<EnvName>('DEV');

  const fetchAll = useCallback(async () => {
    if (!marketCode) return;
    setEnvState({
      DEV: { loading: true, error: null, data: null },
      QA: { loading: true, error: null, data: null },
      PRD: { loading: true, error: null, data: null },
    });
    await Promise.all(
      ENVIRONMENTS.map(async (env) => {
        try {
          const data = await requestService.getCurrentWhitelist(marketCode, env);
          setEnvState((prev) => ({ ...prev, [env]: { loading: false, error: null, data } }));
        } catch (err) {
          console.error(`[CurrentWhitelistPage] Failed to fetch ${env} whitelist:`, err);
          setEnvState((prev) => ({
            ...prev,
            [env]: {
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to fetch the current whitelist',
              data: null,
            },
          }));
        }
      })
    );
  }, [marketCode]);

  // Fires once a market is picked, and again if the viewer picks a
  // different one - not on tab changes, since every environment's data is
  // already loaded by then.
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const readyToShow = Boolean(marketCode);
  const market = config.markets.find((item) => item.code === marketCode);
  const anyLoading = ENVIRONMENTS.some((env) => envState[env].loading);

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Inventory2Icon color="primary" />
        <Typography variant="h4" fontWeight="bold">
          View Whitelist
        </Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        What&apos;s already whitelisted for a market, read live from the source-controlled config
        repo - not from requests submitted through this portal. All three environments load
        together as soon as you pick a market, so switching tabs below is instant.
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'minmax(220px, 0.5fr) auto' },
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
          <Tooltip title="Refresh">
            <span>
              <IconButton onClick={() => void fetchAll()} disabled={!readyToShow || anyLoading}>
                <RefreshIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </Paper>

      {!readyToShow && (
        <Alert severity="info">Select a market above to see its current whitelist.</Alert>
      )}

      {readyToShow && (
        <>
          <Tabs
            value={activeTab}
            onChange={(_e, value: EnvName) => setActiveTab(value)}
            sx={{ mb: 2 }}
          >
            {ENVIRONMENTS.map((env) => (
              <Tab key={env} value={env} label={env} />
            ))}
          </Tabs>

          <EnvironmentSection
            env={activeTab}
            market={market}
            marketCode={marketCode}
            state={envState[activeTab]}
          />
        </>
      )}
    </Container>
  );
}

function EnvironmentSection({
  env,
  market,
  marketCode,
  state,
}: {
  env: EnvName;
  market: { code: string; name: string } | undefined;
  marketCode: string;
  state: EnvState;
}) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="subtitle1" fontWeight="bold" sx={{ mb: 1.5 }}>
        {env}
      </Typography>

      <AgentRoleArn environment={env} marketCode={marketCode} />

      {state.loading && <Loader message={`Reading ${env} whitelist...`} />}

      {!state.loading && state.error && (
        <ErrorState title={`Couldn't load ${env}`} message={state.error} />
      )}

      {!state.loading && !state.error && state.data && !state.data.exists && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Nothing has been whitelisted for {(market?.code || marketCode).toUpperCase()} in {env}{' '}
          yet - this environment&apos;s config file doesn&apos;t exist in the repo yet.
        </Alert>
      )}

      {!state.loading && !state.error && state.data && state.data.exists && (() => {
        const whitelist = state.data;
        return (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          {RESOURCE_TYPES.map((resourceType) => {
            const key = resourceType === 's3Buckets' ? 'buckets'
              : resourceType === 'secretsManager' ? 'secrets'
              : resourceType === 'kmsKeys' ? 'kmsKeys'
              : 'functions';
            const items = whitelist[key];
            const meta = RESOURCE_TYPE_META[resourceType];
            const Icon = meta.icon;
            return (
              <Grid item xs={12} sm={6} key={resourceType}>
                <Paper
                  sx={{
                    p: 3,
                    height: '100%',
                    borderTop: `3px solid ${meta.color}`,
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      mb: 1,
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box sx={{ color: meta.color, display: 'grid', placeItems: 'center' }}>
                        <Icon fontSize="small" />
                      </Box>
                      <Typography variant="h6" fontWeight="bold">
                        {meta.label}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      label={items.length}
                      sx={{
                        bgcolor: alpha(meta.color, 0.12),
                        color: meta.color,
                        fontWeight: 700,
                      }}
                    />
                  </Box>
                  <Divider sx={{ mb: 2 }} />
                  {items.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      None whitelisted in this environment yet.
                    </Typography>
                  ) : (
                    // Full rows instead of Chips - a Chip's label is built to
                    // truncate long text with an ellipsis, which was cutting
                    // real ARNs off mid-string. These wrap instead, so the
                    // whole value is always visible.
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {items.map((value) => (
                        <Box
                          key={value}
                          sx={{
                            px: 1.5,
                            py: 0.75,
                            borderRadius: 1,
                            bgcolor: alpha(meta.color, 0.06),
                            border: '1px solid',
                            borderColor: alpha(meta.color, 0.25),
                          }}
                        >
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: 1.5 }}
                          >
                            {value}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Paper>
              </Grid>
            );
          })}
        </Grid>
        );
      })()}
    </Box>
  );
}
