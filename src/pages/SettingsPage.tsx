import { useState } from 'react';
import {
  Container,
  Typography,
  Paper,
  Box,
  Divider,
  Alert,
  TextField,
  Button,
  Chip,
  Stack,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import { config } from '@/config';
import { useAuth } from '@/auth';

export function SettingsPage() {
  const { isAdminUnlocked, unlockAdminAccess, lockAdminAccess } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = () => {
    if (unlockAdminAccess(code)) {
      setCode('');
      setError(null);
    } else {
      setError('Incorrect code');
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Manage preferences for the whitelisting portal
      </Typography>

      <Paper sx={{ p: 3, mb: config.adminAccessCode ? 3 : 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <SettingsIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Preferences
          </Typography>
        </Box>
        <Divider sx={{ mb: 2 }} />
        <Alert severity="info">
          There&apos;s nothing configurable here yet. Your account details
          (name, email, roles) are managed centrally via Azure AD and can be
          viewed on the Profile page. Portal-level preferences will appear
          here once they&apos;re added.
        </Alert>
      </Paper>

      {/* Only rendered when VITE_ADMIN_ACCESS_CODE is actually set - see
          config.adminAccessCode. This is a stand-in for real Azure AD
          ADMIN app-role assignment, not a security boundary: the code
          is compiled into the public JS bundle and only toggles which
          admin buttons render client-side (the backend has no
          server-side authorization at all yet - see the audit doc's
          auth-gap finding). Remove this panel once real AD roles are
          wired up. */}
      {config.adminAccessCode && (
        <Paper sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <AdminPanelSettingsIcon color="primary" />
            <Typography variant="h6" fontWeight="bold">
              Temporary Admin Access
            </Typography>
          </Box>
          <Divider sx={{ mb: 2 }} />
          <Alert severity="warning" sx={{ mb: 2 }}>
            Interim stand-in until admin access is assigned properly through
            Azure AD app roles. This unlock is not a real security
            boundary - the code lives in the app&apos;s build configuration
            and is visible to anyone who inspects the bundle, and it only
            changes which admin actions show up in this browser tab, not
            what the API itself will accept.
          </Alert>
          {isAdminUnlocked ? (
            <Stack direction="row" spacing={2} alignItems="center">
              <Chip
                label="Admin access unlocked for this tab"
                color="success"
                size="small"
              />
              <Button variant="outlined" size="small" onClick={lockAdminAccess}>
                Lock
              </Button>
            </Stack>
          ) : (
            <Stack direction="row" spacing={2} alignItems="flex-start">
              <TextField
                label="Access code"
                type="password"
                size="small"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError(null);
                }}
                error={!!error}
                helperText={error || ' '}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleUnlock();
                  }
                }}
              />
              <Button
                variant="contained"
                size="small"
                onClick={handleUnlock}
                disabled={!code}
              >
                Unlock
              </Button>
            </Stack>
          )}
        </Paper>
      )}
    </Container>
  );
}
