import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  Container,
  Alert,
} from '@mui/material';
import LoginIcon from '@mui/icons-material/Login';
import { useAuth } from '@/auth';
import { config } from '@/config';

export function LoginPage() {
  const { login, isAuthenticated, isLoading, error } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate(config.routes.dashboard, { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleLogin = async () => {
    try {
      await login();
    } catch (error) {
      console.error('Login error:', error);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: (theme) =>
          theme.palette.mode === 'light'
            ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
            : 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
      }}
    >
      <Container maxWidth="sm">
        <Card
          elevation={8}
          sx={{
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              background: (theme) =>
                theme.palette.mode === 'light'
                  ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  : 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
              padding: 4,
              textAlign: 'center',
              color: 'white',
            }}
          >
            <Typography variant="h4" fontWeight="bold" gutterBottom>
              DPC Whitelisting Portal
            </Typography>
            <Typography variant="body1" sx={{ opacity: 0.9 }}>
              Enterprise Self-Service Platform
            </Typography>
          </Box>

          <CardContent sx={{ padding: 4 }}>
            <Typography
              variant="h5"
              gutterBottom
              textAlign="center"
              fontWeight="500"
            >
              Welcome Back
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              textAlign="center"
              sx={{ mb: 4 }}
            >
              Sign in with your Microsoft account to continue
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}

            <Button
              variant="contained"
              size="large"
              fullWidth
              startIcon={<LoginIcon />}
              onClick={() => void handleLogin()}
              disabled={isLoading}
              sx={{
                py: 1.5,
                fontSize: '1rem',
                textTransform: 'none',
                fontWeight: 600,
                background: (theme) =>
                  theme.palette.mode === 'light'
                    ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                    : 'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
                '&:hover': {
                  background: (theme) =>
                    theme.palette.mode === 'light'
                      ? 'linear-gradient(135deg, #5568d3 0%, #6a3f8f 100%)'
                      : 'linear-gradient(135deg, #152a52 0%, #1f4278 100%)',
                },
              }}
            >
              {isLoading ? 'Signing in...' : 'Sign in with Microsoft'}
            </Button>

            <Box sx={{ mt: 4, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary">
                By signing in, you agree to our Terms of Service and Privacy
                Policy
              </Typography>
            </Box>
          </CardContent>
        </Card>

        <Box sx={{ mt: 3, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'white', opacity: 0.8 }}>
            Need help? Contact IT Support
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}
