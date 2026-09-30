import { Container, Typography, Paper, Box, Divider, Alert } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';

export function SettingsPage() {
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Settings
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Manage preferences for the whitelisting portal
      </Typography>

      <Paper sx={{ p: 3 }}>
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
    </Container>
  );
}
