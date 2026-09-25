import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { config, buildRequestDetailsPath } from '@/config';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import { Snackbar, PolicyPreviewButton } from '@/components/common';
import { CreateRequestFormData, CurrentWhitelist } from '@/types/request.types';
import { NEUTRAL_RESOURCE_COLOR } from '@/constants/resourceTypes';

type ResourceKey =
  's3Buckets' | 'secretsManager' | 'kmsKeys' | 'lambdaFunctions';
type EnvironmentKey = 'DEV' | 'QA' | 'PRD';
type ResourceState = Record<EnvironmentKey, Record<ResourceKey, string[]>>;

const environments: Array<{
  key: EnvironmentKey;
  label: string;
  color: string;
}> = [
  { key: 'DEV', label: 'Development', color: '#5FB88F' },
  { key: 'QA', label: 'QA', color: '#F2C94C' },
  { key: 'PRD', label: 'Production', color: '#E56B6F' },
];

// Icons match AWS's own Architecture Icons per resource type (kept as-is -
// the shape is what makes each type recognizable). Color is intentionally
// NOT AWS's category palette (Storage green, Security red, Compute
// orange) - Secrets Manager and KMS Keys used to render in the same red
// used elsewhere in the portal for errors/rejections. Every resource type
// now shares NEUTRAL_RESOURCE_COLOR (the same constant used on Request
// Details and View Whitelist), so color carries no per-type meaning here
// either - only the icon does.
const resourceTypes: Array<{
  key: ResourceKey;
  label: string;
  helper: string;
  placeholder: string;
  color: string;
  icon: typeof StorageOutlinedIcon;
  isValid: (value: string) => boolean;
}> = [
  {
    key: 's3Buckets',
    label: 'S3 Buckets',
    helper: 'Bucket name, or a full S3 ARN',
    placeholder: 'my-app-uploads',
    color: NEUTRAL_RESOURCE_COLOR,
    icon: StorageOutlinedIcon,
    isValid: (value) =>
      /^(arn:aws:s3:::[a-z0-9.-]{3,63}|[a-z0-9][a-z0-9.-]{1,61}[a-z0-9])$/i.test(
        value
      ),
  },
  {
    key: 'secretsManager',
    label: 'Secrets Manager',
    helper: 'Full AWS Secrets Manager ARN',
    placeholder: 'arn:aws:secretsmanager:region:account:secret:name',
    color: NEUTRAL_RESOURCE_COLOR,
    icon: VpnKeyOutlinedIcon,
    isValid: (value) =>
      /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/i.test(value),
  },
  {
    key: 'kmsKeys',
    label: 'KMS Keys',
    helper: 'Full AWS KMS key ARN',
    placeholder: 'arn:aws:kms:region:account:key/id',
    color: NEUTRAL_RESOURCE_COLOR,
    icon: LockOutlinedIcon,
    isValid: (value) =>
      /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/i.test(value),
  },
  {
    key: 'lambdaFunctions',
    label: 'Lambda Functions',
    helper: 'Full AWS Lambda function ARN',
    placeholder: 'arn:aws:lambda:region:account:function:name',
    color: NEUTRAL_RESOURCE_COLOR,
    icon: FunctionsOutlinedIcon,
    isValid: (value) =>
      /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:.+$/i.test(value),
  },
];

const emptyResources = (): ResourceState => ({
  DEV: { s3Buckets: [], secretsManager: [], kmsKeys: [], lambdaFunctions: [] },
  QA: { s3Buckets: [], secretsManager: [], kmsKeys: [], lambdaFunctions: [] },
  PRD: { s3Buckets: [], secretsManager: [], kmsKeys: [], lambdaFunctions: [] },
});

// Maps a staged resource type to the matching field on CurrentWhitelist -
// the same read-live-from-the-repo data the Current Whitelist page shows
// (see requestService.getCurrentWhitelist / GET /dpc/whitelist/{market}/{env}),
// reused here so a request can't be staged for something already live.
const WHITELIST_FIELD: Record<
  ResourceKey,
  keyof Pick<CurrentWhitelist, 'buckets' | 'secrets' | 'kmsKeys' | 'functions'>
> = {
  s3Buckets: 'buckets',
  secretsManager: 'secrets',
  kmsKeys: 'kmsKeys',
  lambdaFunctions: 'functions',
};

export function CreateRequestPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeEnvironment, setActiveEnvironment] =
    useState<EnvironmentKey>('DEV');
  // A whole submission is either an add or a remove - the backend's
  // request_type is one value for the entire request (see
  // update_yaml_data(request_type=...) in lambda-gitops/handler.py), so
  // this can't vary per resource within one submission. Switching modes
  // clears whatever's staged (see the ToggleButtonGroup onChange below)
  // rather than letting an add and a remove sit side by side and then
  // silently dropping half of it on submit.
  const [requestMode, setRequestMode] = useState<'WHITELIST' | 'DEWHITELIST'>(
    'WHITELIST'
  );
  const [resources, setResources] = useState<ResourceState>(emptyResources);
  const [drafts, setDrafts] = useState<Record<ResourceKey, string>>({
    s3Buckets: '',
    secretsManager: '',
    kmsKeys: '',
    lambdaFunctions: '',
  });
  const [resourceErrors, setResourceErrors] = useState<
    Partial<Record<ResourceKey, string>>
  >({});
  const [marketCode, setMarketCode] = useState('');
  const [businessJustification, setBusinessJustification] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [copied, setCopied] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'info' | 'warning';
  }>({ open: false, message: '', severity: 'info' });

  // What's already live for (market, environment), fetched on demand as
  // the requester picks a market / switches environment tabs, and used to
  // flag a resource they're about to stage that's already whitelisted -
  // see isAlreadyWhitelisted and its use in addResource below. Keyed by
  // "market:env" so switching markets never serves another market's cache.
  const [whitelistCache, setWhitelistCache] = useState<
    Record<string, CurrentWhitelist>
  >({});
  const fetchedWhitelistKeys = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!marketCode) return;
    const key = `${marketCode}:${activeEnvironment}`;
    if (fetchedWhitelistKeys.current.has(key)) return;
    fetchedWhitelistKeys.current.add(key);
    let cancelled = false;
    void (async () => {
      try {
        const data = await requestService.getCurrentWhitelist(
          marketCode,
          activeEnvironment
        );
        if (!cancelled) {
          setWhitelistCache((current) => ({ ...current, [key]: data }));
        }
      } catch (error) {
        // Best-effort only: this check is a convenience, not a hard gate,
        // so a failed lookup just means it's silently skipped rather than
        // blocking the requester from staging resources. Un-mark the key
        // so a later retry (e.g. switching away and back) tries again.
        console.error(
          '[CreateRequestPage] Failed to check current whitelist:',
          error
        );
        fetchedWhitelistKeys.current.delete(key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketCode, activeEnvironment]);

  const isAlreadyWhitelisted = (resourceKey: ResourceKey, value: string) => {
    const data = whitelistCache[`${marketCode}:${activeEnvironment}`];
    if (!data || !data.exists) return false;
    return data[WHITELIST_FIELD[resourceKey]].some(
      (item) => item.toLowerCase() === value.toLowerCase()
    );
  };

  // De-whitelist mode only ever offers resources that are actually live
  // right now (the same source whitelistCache already fetches for the
  // isAlreadyWhitelisted check above), minus whatever's already staged for
  // removal - so there's no freeform typing, no ARN typos, and no way to
  // "de-whitelist" something that was never whitelisted in the first
  // place. Empty (not loading yet, or nothing live) just means the picker
  // below has nothing to offer.
  const resourceOptionsForDewhitelist = (resourceKey: ResourceKey) => {
    const data = whitelistCache[`${marketCode}:${activeEnvironment}`];
    if (!data || !data.exists) return [];
    const staged = new Set(
      resources[activeEnvironment][resourceKey].map((item) => item.toLowerCase())
    );
    return data[WHITELIST_FIELD[resourceKey]].filter(
      (item) => !staged.has(item.toLowerCase())
    );
  };

  const market = config.markets.find((item) => item.code === marketCode);
  const totalResources = useMemo(
    () =>
      Object.values(resources)
        .flatMap((env) => Object.values(env))
        .reduce((sum, items) => sum + items.length, 0),
    [resources]
  );
  const manifestKey =
    requestMode === 'DEWHITELIST' ? 'dewhitelist_request' : 'whitelist_request';
  const manifest = useMemo(() => {
    const output: Record<string, Record<string, string[]>> = {};
    environments.forEach(({ key }) => {
      const configured = Object.fromEntries(
        resourceTypes
          .map(
            ({ key: resourceKey }) =>
              [resourceKey, resources[key][resourceKey]] as const
          )
          .filter(([, values]) => values.length > 0)
      );
      if (Object.keys(configured).length > 0)
        output[key.toLowerCase()] = configured;
    });
    if (format === 'json')
      return JSON.stringify({ [manifestKey]: output }, null, 2);
    const lines = [`${manifestKey}:`];
    Object.entries(output).forEach(([environment, configured]) => {
      lines.push(`  ${environment}:`);
      Object.entries(configured).forEach(([resource, values]) => {
        lines.push(`    ${resource}:`);
        values.forEach((value) => lines.push(`      - ${value}`));
      });
    });
    return lines.length === 1
      ? `  # No resources ${requestMode === 'DEWHITELIST' ? 'selected' : 'added'} yet`
      : lines.join('\n');
  }, [format, resources, manifestKey, requestMode]);

  const addResource = (resourceType: (typeof resourceTypes)[number]) => {
    if (!marketCode) return;
    const value = drafts[resourceType.key].trim();
    if (!value) return;
    if (!resourceType.isValid(value)) {
      setResourceErrors((current) => ({
        ...current,
        [resourceType.key]: `Enter a valid ${resourceType.label} value.`,
      }));
      return;
    }
    if (
      resources[activeEnvironment][resourceType.key].some(
        (item) => item.toLowerCase() === value.toLowerCase()
      )
    ) {
      setResourceErrors((current) => ({
        ...current,
        [resourceType.key]: 'This resource has already been added.',
      }));
      return;
    }
    if (isAlreadyWhitelisted(resourceType.key, value)) {
      setResourceErrors((current) => ({
        ...current,
        [resourceType.key]: `This is already whitelisted in ${activeEnvironment} for ${marketCode || 'this market'} - no need to request it again.`,
      }));
      return;
    }
    setResources((current) => ({
      ...current,
      [activeEnvironment]: {
        ...current[activeEnvironment],
        [resourceType.key]: [
          ...current[activeEnvironment][resourceType.key],
          value,
        ],
      },
    }));
    setDrafts((current) => ({ ...current, [resourceType.key]: '' }));
    setResourceErrors((current) => ({
      ...current,
      [resourceType.key]: undefined,
    }));
  };

  // De-whitelist mode's counterpart to addResource - the value always
  // comes from resourceOptionsForDewhitelist's picker (see the Autocomplete
  // below), so it's already known to be live and valid; nothing left to
  // validate beyond the plain duplicate-staging guard every add goes
  // through.
  const addExistingResource = (resourceKey: ResourceKey, value: string) => {
    if (
      resources[activeEnvironment][resourceKey].some(
        (item) => item.toLowerCase() === value.toLowerCase()
      )
    ) {
      return;
    }
    setResources((current) => ({
      ...current,
      [activeEnvironment]: {
        ...current[activeEnvironment],
        [resourceKey]: [...current[activeEnvironment][resourceKey], value],
      },
    }));
  };

  const removeResource = (resourceKey: ResourceKey, value: string) => {
    setResources((current) => ({
      ...current,
      [activeEnvironment]: {
        ...current[activeEnvironment],
        [resourceKey]: current[activeEnvironment][resourceKey].filter(
          (item) => item !== value
        ),
      },
    }));
  };

  const copyManifest = async () => {
    await navigator.clipboard.writeText(manifest);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const submit = async () => {
    if (!user?.id) {
      setSnackbar({
        open: true,
        severity: 'error',
        message: 'Your signed-in user ID is unavailable. Please sign in again.',
      });
      return;
    }
    if (
      !market ||
      businessJustification.trim().length < 20 ||
      totalResources === 0
    ) {
      setSnackbar({
        open: true,
        severity: 'warning',
        message:
          'Choose a market, add a 20-character justification, and stage at least one resource.',
      });
      return;
    }
    const payload: CreateRequestFormData = {
      marketCode: market.code,
      marketName: market.name,
      businessJustification: businessJustification.trim(),
      environments: environments
        .map(({ key }) => ({
          environment: key,
          resources: {
            s3Buckets: resources[key].s3Buckets.map((bucketName) => ({
              bucketName,
            })),
            secretsManager: resources[key].secretsManager.map((secretArn) => ({
              secretArn,
            })),
            kmsKeys: resources[key].kmsKeys.map((keyArn) => ({ keyArn })),
            lambdaFunctions: resources[key].lambdaFunctions.map(
              (functionArn) => ({ functionArn })
            ),
          },
        }))
        .filter((environment) =>
          Object.values(environment.resources).some((items) => items.length > 0)
        ),
    };
    try {
      setIsSubmitting(true);
      const result = await requestService.createRequest(
        payload,
        { id: user.id, name: user.name, email: user.email },
        requestMode
      );
      setSnackbar({
        open: true,
        severity: 'success',
        message:
          requestMode === 'DEWHITELIST'
            ? `De-whitelist request ${result.requestId} submitted successfully.`
            : `Request ${result.requestId} submitted successfully.`,
      });
      // Straight to the new request's own details page instead of the
      // My Requests list - a submitter checking on what they just filed no
      // longer has to find it among every other request first.
      window.setTimeout(
        () =>
          navigate(buildRequestDetailsPath(result.requestId), {
            state: {
              success: `Request ${result.requestId} submitted successfully.`,
            },
          }),
        1200
      );
    } catch (error) {
      setSnackbar({
        open: true,
        severity: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to submit your request.',
      });
      setIsSubmitting(false);
    }
  };

  return (
    <Container maxWidth="xl" sx={{ py: { xs: 2, md: 4 } }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" fontWeight={700}>
          Create whitelist request
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Stage AWS resources by environment, then submit one complete request.
        </Typography>
      </Box>
      <ToggleButtonGroup
        exclusive
        value={requestMode}
        onChange={(_event, value: 'WHITELIST' | 'DEWHITELIST' | null) => {
          if (!value || value === requestMode) return;
          setRequestMode(value);
          // An add and a remove can't share one request (see the
          // requestMode state comment above) - switching modes starts the
          // staged resources over rather than silently mixing them.
          setResources(emptyResources());
          setDrafts({
            s3Buckets: '',
            secretsManager: '',
            kmsKeys: '',
            lambdaFunctions: '',
          });
          setResourceErrors({});
        }}
        aria-label="Request type"
        size="small"
        sx={{ mb: 2.5 }}
      >
        <ToggleButton value="WHITELIST" sx={{ gap: 1, px: 2 }}>
          <AddCircleOutlineIcon fontSize="small" />
          Whitelist resources
        </ToggleButton>
        <ToggleButton value="DEWHITELIST" sx={{ gap: 1, px: 2 }}>
          <RemoveCircleOutlineIcon fontSize="small" />
          De-whitelist resources
        </ToggleButton>
      </ToggleButtonGroup>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 380px' },
          gap: 3,
          alignItems: 'start',
        }}
      >
        <Stack spacing={2.5}>
          <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 } }}>
            <Typography variant="subtitle1" fontWeight={700}>
              Request details
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.5, mb: 2 }}
            >
              These details accompany the access manifest sent to the existing
              approval workflow.
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: '1fr',
                  sm: 'minmax(220px, 0.45fr) 1fr',
                },
                gap: 2,
              }}
            >
              <TextField
                select
                required
                label="Market"
                value={marketCode}
                onChange={(event) => setMarketCode(event.target.value)}
              >
                {config.markets.map((item) => (
                  <MenuItem key={item.code} value={item.code}>
                    {item.code}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Market name"
                value={market?.name || ''}
                InputProps={{ readOnly: true }}
                placeholder="Select a market"
              />
              <TextField
                required
                multiline
                minRows={3}
                label="Business justification"
                value={businessJustification}
                onChange={(event) =>
                  setBusinessJustification(event.target.value)
                }
                helperText={`${businessJustification.trim().length}/20 minimum characters`}
                sx={{ gridColumn: { sm: '1 / -1' } }}
              />
            </Box>
          </Paper>
          <Box>
            <ToggleButtonGroup
              exclusive
              value={activeEnvironment}
              onChange={(_event, value: EnvironmentKey | null) => {
                if (!value) return;
                setActiveEnvironment(value);
                setDrafts({
                  s3Buckets: '',
                  secretsManager: '',
                  kmsKeys: '',
                  lambdaFunctions: '',
                });
                setResourceErrors({});
              }}
              aria-label="Select environment"
              size="small"
              sx={{ mb: 1.5 }}
            >
              {environments.map((environment) => (
                <ToggleButton
                  key={environment.key}
                  value={environment.key}
                  sx={{ gap: 1, px: { xs: 1.25, sm: 2 } }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: environment.color,
                    }}
                  />
                  {environment.label}
                  <Chip
                    size="small"
                    label={Object.values(resources[environment.key]).reduce(
                      (sum, items) => sum + items.length,
                      0
                    )}
                    sx={{ height: 20, minWidth: 24 }}
                  />
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Alert severity="info" icon={false} sx={{ mb: 2.5, py: 0.5 }}>
              Editing resources for{' '}
              <strong>
                {
                  environments.find((item) => item.key === activeEnvironment)
                    ?.label
                }
              </strong>
              . Your entries in other environments are kept as-is.{' '}
              {requestMode === 'DEWHITELIST'
                ? marketCode
                  ? "Pick from what's currently whitelisted for this market/environment below - only live resources can be selected."
                  : 'Select a market above to see what can be de-whitelisted.'
                : marketCode
                  ? "New entries are checked against what's already whitelisted for this market/environment."
                  : 'Select a market above to also check new entries against what\'s already whitelisted.'}
            </Alert>
            {requestMode === 'WHITELIST' && (
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1.5 }}>
                <PolicyPreviewButton resources={resources[activeEnvironment]} />
              </Box>
            )}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                gap: 2,
              }}
            >
              {resourceTypes.map((resourceType) => {
                const Icon = resourceType.icon;
                const entries = resources[activeEnvironment][resourceType.key];
                return (
                  <Paper
                    key={resourceType.key}
                    variant="outlined"
                    sx={{ p: 2, borderTop: `3px solid ${resourceType.color}` }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        mb: 0.5,
                      }}
                    >
                      <Box
                        sx={{
                          color: resourceType.color,
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        <Icon fontSize="small" />
                      </Box>
                      <Typography
                        variant="subtitle2"
                        fontWeight={700}
                        sx={{ flexGrow: 1 }}
                      >
                        {resourceType.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {entries.length}
                      </Typography>
                    </Box>
                    {requestMode === 'DEWHITELIST' ? (
                      (() => {
                        const dewhitelistOptions = resourceOptionsForDewhitelist(
                          resourceType.key
                        );
                        return (
                          <>
                            <Typography
                              variant="caption"
                              color={marketCode ? 'text.secondary' : 'warning.main'}
                              display="block"
                              sx={{ minHeight: 36 }}
                            >
                              {!marketCode
                                ? 'Select a market above before de-whitelisting resources.'
                                : dewhitelistOptions.length > 0
                                  ? `Pick one currently whitelisted in ${activeEnvironment} to remove it.`
                                  : `Nothing whitelisted in ${activeEnvironment} for this market yet.`}
                            </Typography>
                            <Box sx={{ mt: 1.25 }}>
                              <Autocomplete
                                size="small"
                                fullWidth
                                disabled={!marketCode || dewhitelistOptions.length === 0}
                                options={dewhitelistOptions}
                                value={null}
                                inputValue={drafts[resourceType.key]}
                                onInputChange={(_event, value) =>
                                  setDrafts((current) => ({
                                    ...current,
                                    [resourceType.key]: value,
                                  }))
                                }
                                onChange={(_event, value) => {
                                  if (!value) return;
                                  addExistingResource(resourceType.key, value);
                                  setDrafts((current) => ({
                                    ...current,
                                    [resourceType.key]: '',
                                  }));
                                }}
                                noOptionsText="Nothing whitelisted here yet"
                                renderInput={(params) => (
                                  <TextField
                                    {...params}
                                    placeholder={
                                      marketCode
                                        ? 'Select a whitelisted resource to remove'
                                        : 'Select a market first'
                                    }
                                  />
                                )}
                              />
                            </Box>
                          </>
                        );
                      })()
                    ) : (
                      <>
                        <Typography
                          variant="caption"
                          color={marketCode ? 'text.secondary' : 'warning.main'}
                          display="block"
                          sx={{ minHeight: 36 }}
                        >
                          {marketCode
                            ? resourceType.helper
                            : 'Select a market above before adding resources.'}
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
                          <TextField
                            size="small"
                            fullWidth
                            disabled={!marketCode}
                            placeholder={
                              marketCode
                                ? resourceType.placeholder
                                : 'Select a market first'
                            }
                            value={drafts[resourceType.key]}
                            error={Boolean(resourceErrors[resourceType.key])}
                            onChange={(event) => {
                              setDrafts((current) => ({
                                ...current,
                                [resourceType.key]: event.target.value,
                              }));
                              setResourceErrors((current) => ({
                                ...current,
                                [resourceType.key]: undefined,
                              }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                addResource(resourceType);
                              }
                            }}
                          />
                          <Button
                            variant="outlined"
                            disabled={!marketCode}
                            onClick={() => addResource(resourceType)}
                            startIcon={<AddIcon />}
                          >
                            Add
                          </Button>
                        </Box>
                        {resourceErrors[resourceType.key] && (
                          <Typography
                            variant="caption"
                            color="error"
                            sx={{ mt: 0.75, display: 'block' }}
                          >
                            {resourceErrors[resourceType.key]}
                          </Typography>
                        )}
                      </>
                    )}
                    <Stack spacing={0.5} sx={{ mt: 1.25 }}>
                      {entries.map((entry) => (
                        <Box
                          key={entry}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            bgcolor: 'action.hover',
                            borderRadius: 1,
                            pl: 1,
                            py: 0.25,
                          }}
                        >
                          <Typography
                            variant="caption"
                            sx={{
                              flexGrow: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {entry}
                          </Typography>
                          <Tooltip title="Remove resource">
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() =>
                                removeResource(resourceType.key, entry)
                              }
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      ))}
                      {entries.length === 0 && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          fontStyle="italic"
                        >
                          Nothing added yet for this environment.
                        </Typography>
                      )}
                    </Stack>
                  </Paper>
                );
              })}
            </Box>
          </Box>
        </Stack>
        <Paper
          variant="outlined"
          sx={{ p: 2.5, position: { lg: 'sticky' }, top: { lg: 88 } }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'start',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Box>
              <Typography variant="overline" color="text.secondary">
                Live preview
              </Typography>
              <Typography variant="h6" fontWeight={700}>
                manifest.{format === 'yaml' ? 'yml' : 'json'}
              </Typography>
            </Box>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={format}
              onChange={(_event, value: 'yaml' | 'json' | null) =>
                value && setFormat(value)
              }
            >
              <ToggleButton value="yaml">YAML</ToggleButton>
              <ToggleButton value="json">JSON</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box
            component="pre"
            sx={{
              mt: 2,
              mb: 2,
              minHeight: 190,
              maxHeight: 360,
              overflow: 'auto',
              bgcolor: 'grey.900',
              color: 'grey.100',
              borderRadius: 1.5,
              p: 1.5,
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {manifest}
          </Box>
          <Divider sx={{ mb: 1.5 }} />
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 2,
            }}
          >
            <Typography variant="body2">
              <strong>{totalResources}</strong> resource
              {totalResources === 1 ? '' : 's'} staged
            </Typography>
            <Button
              size="small"
              startIcon={
                copied ? <CheckCircleOutlineIcon /> : <ContentCopyIcon />
              }
              onClick={() => void copyManifest()}
              disabled={!totalResources}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </Box>
          <Button
            fullWidth
            variant="contained"
            color={requestMode === 'DEWHITELIST' ? 'error' : 'primary'}
            size="large"
            onClick={() => void submit()}
            disabled={isSubmitting || totalResources === 0}
            startIcon={isSubmitting ? undefined : <CheckCircleOutlineIcon />}
          >
            {isSubmitting
              ? 'Submitting request…'
              : requestMode === 'DEWHITELIST'
                ? 'Submit de-whitelist request'
                : 'Submit whitelist request'}
          </Button>
          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            sx={{ mt: 1.5 }}
          >
            Submission uses the existing API Gateway request flow.
          </Typography>
        </Paper>
      </Box>
      <Snackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar((current) => ({ ...current, open: false }))}
        autoHideDuration={6000}
      />
    </Container>
  );
}
