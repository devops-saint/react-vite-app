import {
  Container,
  Typography,
  Paper,
  Box,
  Divider,
  Avatar,
  Chip,
  Grid,
  Stack,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import { useAuth } from '@/auth';

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function ProfilePage() {
  const { user } = useAuth();

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Profile
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Your account details, as provided by your Azure AD sign-in
      </Typography>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <PersonIcon color="primary" />
          <Typography variant="h6" fontWeight="bold">
            Account Details
          </Typography>
        </Box>
        <Divider sx={{ mb: 3 }} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Avatar
            sx={{
              width: 64,
              height: 64,
              bgcolor: 'secondary.main',
              fontSize: '1.5rem',
            }}
          >
            {user ? getInitials(user.name) : 'U'}
          </Avatar>
          <Box>
            <Typography variant="h6">{user?.name || '—'}</Typography>
            <Typography variant="body2" color="text.secondary">
              {user?.email || '—'}
            </Typography>
          </Box>
        </Box>

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <Typography variant="caption" color="text.secondary">
              Name
            </Typography>
            <Typography variant="body1">{user?.name || '—'}</Typography>
          </Grid>
          <Grid item xs={12} sm={6}>
            <Typography variant="caption" color="text.secondary">
              Email
            </Typography>
            <Typography variant="body1">{user?.email || '—'}</Typography>
          </Grid>
          {user?.department && (
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary">
                Department
              </Typography>
              <Typography variant="body1">{user.department}</Typography>
            </Grid>
          )}
          {user?.jobTitle && (
            <Grid item xs={12} sm={6}>
              <Typography variant="caption" color="text.secondary">
                Job Title
              </Typography>
              <Typography variant="body1">{user.jobTitle}</Typography>
            </Grid>
          )}
          <Grid item xs={12}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
              Roles
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {user?.roles && user.roles.length > 0 ? (
                user.roles.map((role) => (
                  <Chip key={role} label={role} size="small" color="primary" variant="outlined" />
                ))
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No roles assigned
                </Typography>
              )}
            </Stack>
          </Grid>
        </Grid>
      </Paper>
    </Container>
  );
}
