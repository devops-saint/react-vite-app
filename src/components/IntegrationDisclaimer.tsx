import { Alert, Box, Link, Typography } from '@mui/material';
import { config } from '@/config';

/**
 * Persistent, portal-wide notice that whitelisting through the portal may
 * only be one part of the overall integration process - rendered in
 * DashboardLayout so it appears above every authenticated page, not just
 * request-related ones. Message and links are both environment-driven
 * (see config.integrationDisclaimer / VITE_INTEGRATION_DISCLAIMER_TEXT /
 * VITE_DOCUMENTATION_LINKS) so they can be updated per-deployment without
 * a code change, and the whole banner can be turned off via
 * VITE_SHOW_INTEGRATION_DISCLAIMER=false if it's ever not wanted.
 */
export function IntegrationDisclaimer() {
  const { enabled, message, links } = config.integrationDisclaimer;

  if (!enabled) return null;

  return (
    <Alert severity="info" icon={false} sx={{ mb: 2 }}>
      <Typography variant="body2">{message}</Typography>
      {links.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 0.5 }}>
          {links.map((link) => (
            <Link key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" variant="body2">
              {link.label}
            </Link>
          ))}
        </Box>
      )}
    </Alert>
  );
}
