import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { config } from '@/config';
import {
  Alert,
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
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import { requestService } from '@/api/services';
import { useAuth } from '@/auth';
import { Snackbar } from '@/components/common';
import { CreateRequestFormData } from '@/types/request.types';

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
    color: '#F2A65A',
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
    color: '#E56B6F',
    icon: VpnKeyOutlinedIcon,
    isValid: (value) =>
      /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/i.test(value),
  },
  {
    key: 'kmsKeys',
    label: 'KMS Keys',
    helper: 'Full AWS KMS key ARN',
    placeholder: 'arn:aws:kms:region:account:key/id',
    color: '#9B8AFB',
    icon: LockOutlinedIcon,
    isValid: (value) =>
      /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]+$/i.test(value),
  },
  {
    key: 'lambdaFunctions',
    label: 'Lambda Functions',
    helper: 'Full AWS Lambda function ARN',
    placeholder: 'arn:aws:lambda:region:account:function:name',
    color: '#5AA9E6',
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

export function CreateRequestPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activeEnvironment, setActiveEnvironment] =
    useState<EnvironmentKey>('DEV');
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

  const market = config.markets.find((item) => item.code === marketCode);
  const totalResources = useMemo(
    () =>
      Object.values(resources)
        .flatMap((env) => Object.values(env))
        .reduce((sum, items) => sum + items.length, 0),
    [resources]
  );
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
      return JSON.stringify({ whitelist_request: output }, null, 2);
    const lines = ['whitelist_request:'];
    Object.entries(output).forEach(([environment, configured]) => {
      lines.push(`  ${environment}:`);
      Object.entries(configured).forEach(([resource, values]) => {
        lines.push(`    ${resource}:`);
        values.forEach((value) => lines.push(`      - ${value}`));
      });
    });
    return lines.length === 1 ? '  # No resources added yet' : lines.join('\n');
  }, [format, resources]);

  const addResource = (resourceType: (typeof resourceTypes)[number]) => {
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
      const result = await requestService.createRequest(payload, {
        id: user.id,
        name: user.name,
        email: user.email,
      });
      setSnackbar({
        open: true,
        severity: 'success',
        message: `Request ${result.requestId} submitted successfully.`,
      });
      window.setTimeout(
        () =>
          navigate(config.routes.requests, {
            state: {
              success: `Request ${result.requestId} submitted successfully.`,
              requestId: result.requestId,
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
                    {item.code} — {item.name}
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
              onChange={(_event, value: EnvironmentKey | null) =>
                value && setActiveEnvironment(value)
              }
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
              . Your entries in other environments are kept as-is.
            </Alert>
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
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      sx={{ minHeight: 36 }}
                    >
                      {resourceType.helper}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
                      <TextField
                        size="small"
                        fullWidth
                        placeholder={resourceType.placeholder}
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
            size="large"
            onClick={() => void submit()}
            disabled={isSubmitting || totalResources === 0}
            startIcon={isSubmitting ? undefined : <CheckCircleOutlineIcon />}
          >
            {isSubmitting ? 'Submitting request…' : 'Submit whitelist request'}
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
