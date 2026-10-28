import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { buildRequestDetailsPath } from '@/config';
import { useMarkets } from '@/hooks';
import {
  Alert,
  Link,
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
import { alpha } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import { Snackbar, PolicyPreviewButton } from '@/components/common';
import {
  CreateRequestFormData,
  CurrentWhitelist,
  EnvironmentResources,
  RequestType,
} from '@/types/request.types';
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

const countResources = (state: ResourceState) =>
  Object.values(state)
    .flatMap((env) => Object.values(env))
    .reduce((sum, items) => sum + items.length, 0);

const toEnvironmentResources = (
  items: Record<ResourceKey, string[]>
): EnvironmentResources => ({
  s3Buckets: items.s3Buckets.map((bucketName) => ({ bucketName })),
  secretsManager: items.secretsManager.map((secretArn) => ({ secretArn })),
  kmsKeys: items.kmsKeys.map((keyArn) => ({ keyArn })),
  lambdaFunctions: items.lambdaFunctions.map((functionArn) => ({
    functionArn,
  })),
});

const hasAnyResource = (resources: EnvironmentResources) =>
  resources.s3Buckets.length > 0 ||
  resources.secretsManager.length > 0 ||
  resources.kmsKeys.length > 0 ||
  resources.lambdaFunctions.length > 0;

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
  const { user, accessStatus, canMutate, hasMarketAccess, hasEnvironmentAccess } = useAuth();
  // Markets come from the folders in the config repo, not a static list.
  const {
    markets: repoMarkets,
    loading: marketsLoading,
    fallback: marketsFallback,
    reload: reloadMarkets,
  } = useMarkets();
  const [activeEnvironment, setActiveEnvironment] =
    useState<EnvironmentKey>('DEV');
  // One submission can both add and remove: `resources` is what's staged
  // to ADD (typed in), `removals` is what's been crossed off the
  // "currently whitelisted" lists to REMOVE. The request type sent to the
  // backend is derived from which of the two are non-empty (see
  // requestType below).
  const [resources, setResources] = useState<ResourceState>(emptyResources);
  const [removals, setRemovals] = useState<ResourceState>(emptyResources);
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
  // "market:env" keys whose lookup failed, plus a counter the Retry button
  // bumps to run the fetch effect again.
  const [whitelistFailed, setWhitelistFailed] = useState<
    Record<string, boolean>
  >({});
  const [whitelistReload, setWhitelistReload] = useState(0);

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
          setWhitelistFailed((current) => ({ ...current, [key]: false }));
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
        if (!cancelled) {
          setWhitelistFailed((current) => ({ ...current, [key]: true }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marketCode, activeEnvironment, whitelistReload]);

  useEffect(() => {
    if (!marketCode) return;
    const stillVisible = environments.some(
      (item) =>
        item.key === activeEnvironment && hasEnvironmentAccess(marketCode, item.key)
    );
    if (stillVisible) return;
    const fallback = environments.find((item) =>
      hasEnvironmentAccess(marketCode, item.key)
    );
    if (fallback) setActiveEnvironment(fallback.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketCode, hasEnvironmentAccess]);

  const isAlreadyWhitelisted = (resourceKey: ResourceKey, value: string) => {
    const data = whitelistCache[`${marketCode}:${activeEnvironment}`];
    if (!data || !data.exists) return false;
    return data[WHITELIST_FIELD[resourceKey]].some(
      (item) => item.toLowerCase() === value.toLowerCase()
    );
  };

  // Resources that are live right now for the selected market/environment
  // (the same data whitelistCache already fetches for the
  // isAlreadyWhitelisted check above). These are listed under each
  // resource type with a cross to mark them for removal - removal can
  // only ever target something that is really live, so there's no
  // freeform typing and no way to "de-whitelist" something that was never
  // whitelisted. Empty while loading, when nothing is live, or before a
  // market is chosen.
  const liveEntriesFor = (resourceKey: ResourceKey): string[] => {
    const data = whitelistCache[`${marketCode}:${activeEnvironment}`];
    if (!data || !data.exists) return [];
    return data[WHITELIST_FIELD[resourceKey]];
  };

  const market = repoMarkets.find((item) => item.code === marketCode);
  // Idea #19 (RBAC-Gated Create Request): only offer markets/environments
  // this user actually has access to. Falls back to the unfiltered list
  // while access is still loading or couldn't be determined - see
  // AuthProvider's hasMarketAccess/hasEnvironmentAccess doc comments.
  const visibleMarkets = repoMarkets.filter((item) =>
    hasMarketAccess(item.code)
  );
  const visibleEnvironments = marketCode
    ? environments.filter((item) => hasEnvironmentAccess(marketCode, item.key))
    : environments;
  const addCount = useMemo(() => countResources(resources), [resources]);
  const removeCount = useMemo(() => countResources(removals), [removals]);
  const totalResources = addCount + removeCount;
  // What gets sent: only adds, only removals (the existing de-whitelist
  // request), or both together.
  const requestType: RequestType =
    addCount > 0 && removeCount > 0
      ? 'COMBINED'
      : removeCount > 0
        ? 'DEWHITELIST'
        : 'WHITELIST';
  const manifest = useMemo(() => {
    const sectionFor = (state: ResourceState) => {
      const output: Record<string, Record<string, string[]>> = {};
      environments.forEach(({ key }) => {
        const configured = Object.fromEntries(
          resourceTypes
            .map(
              ({ key: resourceKey }) =>
                [resourceKey, state[key][resourceKey]] as const
            )
            .filter(([, values]) => values.length > 0)
        );
        if (Object.keys(configured).length > 0)
          output[key.toLowerCase()] = configured;
      });
      return output;
    };
    const present = (
      [
        ['whitelist_request', sectionFor(resources)],
        ['dewhitelist_request', sectionFor(removals)],
      ] as const
    ).filter(([, output]) => Object.keys(output).length > 0);
    if (format === 'json')
      return JSON.stringify(Object.fromEntries(present), null, 2);
    if (present.length === 0) return '  # Nothing staged yet';
    const lines: string[] = [];
    present.forEach(([name, output]) => {
      lines.push(`${name}:`);
      Object.entries(output).forEach(([environment, configured]) => {
        lines.push(`  ${environment}:`);
        Object.entries(configured).forEach(([resource, values]) => {
          lines.push(`    ${resource}:`);
          values.forEach((value) => lines.push(`      - ${value}`));
        });
      });
    });
    return lines.join('\n');
  }, [format, resources, removals]);

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

  // Cross / undo on a currently-whitelisted row: marks the resource for
  // removal in this request, or takes the mark back off.
  const toggleRemoval = (resourceKey: ResourceKey, value: string) => {
    setRemovals((current) => {
      const list = current[activeEnvironment][resourceKey];
      const marked = list.some(
        (item) => item.toLowerCase() === value.toLowerCase()
      );
      return {
        ...current,
        [activeEnvironment]: {
          ...current[activeEnvironment],
          [resourceKey]: marked
            ? list.filter((item) => item.toLowerCase() !== value.toLowerCase())
            : [...list, value],
        },
      };
    });
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
    if (!canMutate) {
      setSnackbar({
        open: true,
        severity: 'error',
        message:
          'Your access permissions couldn\'t be verified, so request creation is disabled right now. Refresh the page to retry.',
      });
      return;
    }
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
      businessJustification.trim().length === 0 ||
      totalResources === 0
    ) {
      setSnackbar({
        open: true,
        severity: 'warning',
        message:
          'Choose a market, add a business justification, and stage at least one resource.',
      });
      return;
    }
    const payload: CreateRequestFormData = {
      marketCode: market.code,
      marketName: market.name,
      businessJustification: businessJustification.trim(),
      environments: environments
        .map(({ key }) => {
          const adds = toEnvironmentResources(resources[key]);
          const removes = toEnvironmentResources(removals[key]);
          // Removal-only requests keep the existing de-whitelist shape
          // (the lists are the resources to remove); a combined request
          // carries the removals alongside the additions.
          if (requestType === 'DEWHITELIST') {
            return { environment: key, resources: removes };
          }
          if (requestType === 'COMBINED') {
            return { environment: key, resources: adds, removals: removes };
          }
          return { environment: key, resources: adds };
        })
        .filter(
          (environment) =>
            hasAnyResource(environment.resources) ||
            (environment.removals !== undefined &&
              hasAnyResource(environment.removals))
        ),
    };
    try {
      setIsSubmitting(true);
      const result = await requestService.createRequest(
        payload,
        { id: user.id, name: user.name, email: user.email },
        requestType
      );
      setSnackbar({
        open: true,
        severity: 'success',
        message:
          requestType === 'DEWHITELIST'
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
          Add new AWS resources and/or remove currently whitelisted ones, by
          environment, then submit everything as one request.
        </Typography>
      </Box>
      {accessStatus === 'error' && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Your access permissions couldn&apos;t be verified, so this page is read-only right
          now - you can browse but not submit a request. Refresh to try again, or contact
          support if this persists.
        </Alert>
      )}
      {marketsFallback && (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          Couldn&apos;t load the market list from the repository, so the configured list is
          shown instead - it may be out of date.{' '}
          <Link component="button" type="button" onClick={reloadMarkets} sx={{ verticalAlign: 'baseline' }}>
            Retry
          </Link>
        </Alert>
      )}
      {accessStatus === 'loaded' && !marketsLoading && visibleMarkets.length === 0 && (
        <Alert severity="info" sx={{ mb: 2.5 }}>
          You don&apos;t currently have access to request any market. Contact your admin if
          this looks wrong.
        </Alert>
      )}
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
                onChange={(event) => {
                  setMarketCode(event.target.value);
                  // Removals refer to the previous market's live resources,
                  // so they can't carry over to another market.
                  setRemovals(emptyResources());
                }}
              >
                {visibleMarkets.map((item) => (
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
              {visibleEnvironments.map((environment) => (
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
                    label={
                      countResources({
                        ...emptyResources(),
                        [environment.key]: resources[environment.key],
                      }) +
                      countResources({
                        ...emptyResources(),
                        [environment.key]: removals[environment.key],
                      })
                    }
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
              {marketCode
                ? "Type new resources to add them (checked against what's already whitelisted). Use the ✕ next to a currently whitelisted resource to remove it. Both can go in the same request."
                : "Select a market above to see what's already whitelisted and to remove existing resources."}
            </Alert>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1.5 }}>
              <PolicyPreviewButton resources={resources[activeEnvironment]} />
            </Box>
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
                        {entries.length +
                          removals[activeEnvironment][resourceType.key].length}
                      </Typography>
                    </Box>
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
                    <Divider sx={{ my: 1.5 }} />
                    {(() => {
                      const liveKey = `${marketCode}:${activeEnvironment}`;
                      const live = liveEntriesFor(resourceType.key);
                      const marked = removals[activeEnvironment][resourceType.key];
                      const hasData = Boolean(whitelistCache[liveKey]);
                      return (
                        <>
                          <Typography
                            variant="caption"
                            fontWeight={700}
                            color="text.secondary"
                            display="block"
                            sx={{ mb: 0.5 }}
                          >
                            Currently whitelisted
                            {marketCode && hasData ? ` (${live.length})` : ''}
                          </Typography>
                          {!marketCode ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontStyle="italic"
                            >
                              Select a market to see what is whitelisted.
                            </Typography>
                          ) : whitelistFailed[liveKey] ? (
                            <Typography variant="caption" color="error">
                              Couldn&apos;t load the current whitelist.{' '}
                              <Button
                                size="small"
                                onClick={() => {
                                  setWhitelistFailed((current) => ({
                                    ...current,
                                    [liveKey]: false,
                                  }));
                                  setWhitelistReload((count) => count + 1);
                                }}
                              >
                                Retry
                              </Button>
                            </Typography>
                          ) : !hasData ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontStyle="italic"
                            >
                              Loading currently whitelisted resources…
                            </Typography>
                          ) : live.length === 0 ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              fontStyle="italic"
                            >
                              Nothing whitelisted in {activeEnvironment} for this
                              market yet.
                            </Typography>
                          ) : (
                            <Stack
                              spacing={0.5}
                              sx={{ maxHeight: 220, overflow: 'auto' }}
                            >
                              {live.map((item) => {
                                const isMarked = marked.some(
                                  (value) =>
                                    value.toLowerCase() === item.toLowerCase()
                                );
                                return (
                                  <Box
                                    key={item}
                                    sx={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 0.5,
                                      borderRadius: 1,
                                      pl: 1,
                                      py: 0.25,
                                      bgcolor: isMarked
                                        ? (theme) =>
                                            alpha(theme.palette.error.main, 0.12)
                                        : 'action.hover',
                                    }}
                                  >
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        flexGrow: 1,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        textDecoration: isMarked
                                          ? 'line-through'
                                          : 'none',
                                      }}
                                    >
                                      {item}
                                    </Typography>
                                    {isMarked && (
                                      <Chip
                                        size="small"
                                        color="error"
                                        label="Will be removed"
                                        sx={{ height: 18, fontSize: 10 }}
                                      />
                                    )}
                                    <Tooltip
                                      title={
                                        isMarked
                                          ? 'Keep it (undo removal)'
                                          : 'Remove from whitelist'
                                      }
                                    >
                                      <IconButton
                                        size="small"
                                        color={isMarked ? 'default' : 'error'}
                                        aria-label={
                                          isMarked
                                            ? `Keep ${item}`
                                            : `Remove ${item} from whitelist`
                                        }
                                        onClick={() =>
                                          toggleRemoval(resourceType.key, item)
                                        }
                                      >
                                        {isMarked ? (
                                          <UndoIcon fontSize="small" />
                                        ) : (
                                          <CloseIcon fontSize="small" />
                                        )}
                                      </IconButton>
                                    </Tooltip>
                                  </Box>
                                );
                              })}
                            </Stack>
                          )}
                        </>
                      );
                    })()}
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
              <strong>{totalResources}</strong> change
              {totalResources === 1 ? '' : 's'} staged
              {totalResources > 0 &&
                ` (${addCount} to add, ${removeCount} to remove)`}
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
            color={requestType === 'DEWHITELIST' ? 'error' : 'primary'}
            size="large"
            onClick={() => void submit()}
            disabled={isSubmitting || totalResources === 0 || !canMutate}
            startIcon={isSubmitting ? undefined : <CheckCircleOutlineIcon />}
          >
            {isSubmitting
              ? 'Submitting request…'
              : requestType === 'COMBINED'
                ? 'Submit whitelist + de-whitelist request'
                : requestType === 'DEWHITELIST'
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
