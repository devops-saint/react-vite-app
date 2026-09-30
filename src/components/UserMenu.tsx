import { useState } from 'react';
import {
  IconButton,
  Menu,
  MenuItem,
  Avatar,
  ListItemIcon,
  Divider,
  Typography,
  Box,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import LogoutIcon from '@mui/icons-material/Logout';
import { useAuth } from '@/auth';
import { useNavigate } from 'react-router-dom';
import { config } from '@/config';

export function UserMenu() {
  const { user, logout, access, accessStatus } = useAuth();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleProfile = () => {
    navigate(config.routes.profile);
    handleClose();
  };

  const handleSettings = () => {
    navigate(config.routes.settings);
    handleClose();
  };

  const handleLogout = async () => {
    handleClose();
    try {
      await logout();
      navigate(config.routes.login);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // Small role label shown under the avatar in the header (below the name
  // shortform), reflecting the RBAC lookup (GET /access, idea #19) - not
  // the Azure AD app-role claims shown on the Profile page's "Azure AD App
  // Roles" list, which is a separate, older signal. Kept short/quiet since
  // this is just an at-a-glance label, not a security boundary in itself.
  const rbacRoleLabel =
    accessStatus === 'loaded' ? (access?.role === 'admin' ? 'Admin' : 'User') : null;

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <IconButton
          onClick={handleClick}
          size="small"
          aria-controls={open ? 'user-menu' : undefined}
          aria-haspopup="true"
          aria-expanded={open ? 'true' : undefined}
        >
          <Avatar
            sx={{
              width: 32,
              height: 32,
              bgcolor: 'secondary.main',
              fontSize: '0.875rem',
            }}
          >
            {user ? getInitials(user.name) : 'U'}
          </Avatar>
        </IconButton>
        {rbacRoleLabel && (
          <Typography
            variant="caption"
            sx={{
              lineHeight: 1,
              mt: 0.25,
              color: 'inherit',
              opacity: 0.85,
              fontSize: '0.65rem',
            }}
          >
            {rbacRoleLabel}
          </Typography>
        )}
      </Box>

      <Menu
        anchorEl={anchorEl}
        id="user-menu"
        open={open}
        onClose={handleClose}
        onClick={handleClose}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        PaperProps={{
          elevation: 3,
          sx: {
            minWidth: 220,
            mt: 1.5,
          },
        }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" fontWeight="600">
            {user?.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {user?.email}
          </Typography>
        </Box>

        <Divider />

        <MenuItem onClick={handleProfile}>
          <ListItemIcon>
            <PersonIcon fontSize="small" />
          </ListItemIcon>
          Profile
        </MenuItem>

        <MenuItem onClick={handleSettings}>
          <ListItemIcon>
            <SettingsIcon fontSize="small" />
          </ListItemIcon>
          Settings
        </MenuItem>

        <Divider />

        <MenuItem onClick={() => void handleLogout()}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          Logout
        </MenuItem>
      </Menu>
    </>
  );
}
