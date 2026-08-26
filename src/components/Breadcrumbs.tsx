import { Link as RouterLink, useLocation } from 'react-router-dom';
import { Breadcrumbs as MuiBreadcrumbs, Link, Typography } from '@mui/material';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import HomeIcon from '@mui/icons-material/Home';
import { config } from '@/config';

const routeNameMap: Record<string, string> = {
  dashboard: 'Dashboard',
  requests: 'Requests',
  my: 'My Requests',
  new: 'New Request',
  pending: 'Pending Approval',
  resources: 'AWS Resources',
  users: 'Users',
  settings: 'Settings',
  profile: 'Profile',
};

export function Breadcrumbs() {
  const location = useLocation();
  const pathnames = location.pathname.split('/').filter((x) => x);

  if (pathnames.length === 0 || location.pathname === '/') {
    return null;
  }

  return (
    <MuiBreadcrumbs
      separator={<NavigateNextIcon fontSize="small" />}
      aria-label="breadcrumb"
      sx={{ mb: 2 }}
    >
      <Link
        component={RouterLink}
        to={config.routes.dashboard}
        underline="hover"
        color="inherit"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
        }}
      >
        <HomeIcon fontSize="small" />
        Home
      </Link>

      {pathnames.map((value, index) => {
        const last = index === pathnames.length - 1;
        const to = `/${pathnames.slice(0, index + 1).join('/')}`;
        const label = routeNameMap[value] || value.charAt(0).toUpperCase() + value.slice(1);

        return last ? (
          <Typography key={to} color="text.primary" fontWeight={500}>
            {label}
          </Typography>
        ) : (
          <Link
            key={to}
            component={RouterLink}
            to={to}
            underline="hover"
            color="inherit"
          >
            {label}
          </Link>
        );
      })}
    </MuiBreadcrumbs>
  );
}
