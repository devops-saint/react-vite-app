import { Box, Typography, IconButton, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { buildAgentRoleArn } from '@/config';

/**
 * One-click-copy display of the Matillion agent IAM role ARN for a given
 * market + environment, so a client can grab the exact ARN they need for
 * their side of the integration without opening a support ticket or
 * digging through terraform. Renders nothing when VITE_AWS_ACCOUNT_ID
 * isn't configured (buildAgentRoleArn returns null), rather than showing
 * a broken ARN with an empty account id segment.
 */
export function AgentRoleArn({ environment, marketCode }: { environment: string; marketCode: string }) {
  const arn = buildAgentRoleArn(environment, marketCode);
  if (!arn) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        mb: 2,
        borderRadius: 1,
        bgcolor: 'action.hover',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="caption" color="text.secondary" display="block">
          Agent Role ARN
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {arn}
        </Typography>
      </Box>
      <Tooltip title="Copy ARN">
        <IconButton size="small" onClick={() => void navigator.clipboard.writeText(arn)}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
