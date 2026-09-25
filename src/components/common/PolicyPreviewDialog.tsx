import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Alert,
  Box,
} from '@mui/material';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CloseIcon from '@mui/icons-material/Close';
import { buildPolicyPreview, PolicyPreviewInput } from '@/utils/policyPreview';

/**
 * "Preview Policy" trigger + dialog, reused on Create Request (staged,
 * not-yet-submitted resources) and Request Details (already-submitted
 * resources) - see buildPolicyPreview for why this is a representative
 * template rather than the real one.
 */
export function PolicyPreviewButton({
  resources,
  label = 'Preview Policy',
}: {
  resources: PolicyPreviewInput;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasAnyResource =
    resources.s3Buckets.length > 0 ||
    resources.secretsManager.length > 0 ||
    resources.kmsKeys.length > 0 ||
    resources.lambdaFunctions.length > 0;

  const document = buildPolicyPreview(resources);
  const documentText = JSON.stringify(document, null, 2);

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<PolicyOutlinedIcon />}
        disabled={!hasAnyResource}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Cross-Account Policy Preview
          <IconButton size="small" onClick={() => setOpen(false)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            This is a representative policy, built from a standard AWS action
            template - not a guaranteed copy of the actual policy that will be
            applied. Use it to understand roughly what access is being
            granted for each resource.
          </Alert>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              borderRadius: 1,
              bgcolor: 'action.hover',
              border: '1px solid',
              borderColor: 'divider',
              fontFamily: 'monospace',
              fontSize: '0.8125rem',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {documentText}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<ContentCopyIcon />}
            onClick={() => void navigator.clipboard.writeText(documentText)}
          >
            Copy
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
