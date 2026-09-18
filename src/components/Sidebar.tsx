import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Divider,
  Box,
  Tooltip,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import AddIcon from '@mui/icons-material/Add';
import AssignmentIcon from '@mui/icons-material/Assignment';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { config } from '@/config';

const DRAWER_WIDTH = 260;
// Collapsed desktop rail width - just wide enough for a centered icon plus
// padding. This is the width DashboardLayout's main content always treats
// as reserved (see the nav Box below), so hovering to expand never shifts
// the page - the expanded rail simply overlays on top of it.
const RAIL_WIDTH = 72;

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

interface MenuItem {
  title: string;
  icon: React.ReactNode;
  path: string;
}

const menuItems: MenuItem[] = [
  {
    title: 'Dashboard',
    icon: <DashboardIcon />,
    path: config.routes.dashboard,
  },
  {
    title: 'Create Request',
    icon: <AddIcon />,
    path: config.routes.requestsCreate,
  },
  {
    title: 'My Requests',
    icon: <AssignmentIcon />,
    path: config.routes.requests,
  },
  {
    title: 'View Whitelist',
    icon: <Inventory2Icon />,
    path: config.routes.whitelist,
  },
  {
    title: 'Help',
    icon: <HelpOutlineIcon />,
    path: config.routes.help,
  },
];

export function Sidebar({ open, onClose }: SidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  // Desktop-only: the rail starts collapsed to icons and expands to show
  // labels while the pointer is over it. Irrelevant on mobile/tablet,
  // where the temporary overlay drawer below is always shown at full width.
  const [expanded, setExpanded] = useState(false);

  const handleItemClick = (path: string) => {
    onClose(); // Close mobile overlay drawer before navigation
    setExpanded(false); // Collapse the desktop rail back on navigation too
    navigate(path);
  };

  const isActive = (path: string) => {
    return location.pathname === path;
  };

  const renderMenuList = (showLabels: boolean) => (
    <List>
      {menuItems.map((item) => {
        const active = isActive(item.path);
        const button = (
          <ListItemButton
            selected={active}
            onClick={() => handleItemClick(item.path)}
            sx={{
              minHeight: 48,
              justifyContent: showLabels ? 'flex-start' : 'center',
              px: 2.5,
              '&.Mui-selected': {
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                '&:hover': {
                  bgcolor: 'primary.dark',
                },
                '& .MuiListItemIcon-root': {
                  color: 'primary.contrastText',
                },
              },
            }}
          >
            <ListItemIcon
              sx={{
                minWidth: 0,
                mr: showLabels ? 2 : 'auto',
                justifyContent: 'center',
                color: active ? 'inherit' : 'text.secondary',
              }}
            >
              {item.icon}
            </ListItemIcon>
            <ListItemText
              primary={item.title}
              sx={{
                opacity: showLabels ? 1 : 0,
                whiteSpace: 'nowrap',
                transition: (theme) => theme.transitions.create('opacity'),
              }}
              primaryTypographyProps={{
                fontSize: '0.875rem',
                fontWeight: active ? 600 : 400,
              }}
            />
          </ListItemButton>
        );
        return (
          <ListItem key={item.title} disablePadding>
            {/* Only needed while collapsed - once labels are showing the
                text itself already says what the icon means. */}
            {showLabels ? button : (
              <Tooltip title={item.title} placement="right">
                {button}
              </Tooltip>
            )}
          </ListItem>
        );
      })}
    </List>
  );

  return (
    <Box component="nav" sx={{ width: { md: RAIL_WIDTH }, flexShrink: { md: 0 } }}>
      {/* Mobile/tablet: overlay drawer, closed by default, opened via the
          Header hamburger and dismissed on navigation or backdrop click -
          unchanged from before, always shows full labels. */}
      <Drawer
        variant="temporary"
        open={open}
        onClose={onClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
          },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'auto' }}>
          {renderMenuList(true)}
          <Divider />
        </Box>
      </Drawer>

      {/* Desktop: a slim, always-visible icon rail (no hamburger needed) that
          expands into the full labeled drawer on hover, then collapses back
          on mouse-leave or navigation. The rail's Paper is fixed-position so
          expanding it overlays the page instead of pushing content - the nav
          Box above keeps reserving just RAIL_WIDTH regardless of hover. */}
      <Drawer
        variant="permanent"
        open
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        sx={{
          display: { xs: 'none', md: 'block' },
          '& .MuiDrawer-paper': {
            position: 'fixed',
            width: expanded ? DRAWER_WIDTH : RAIL_WIDTH,
            overflowX: 'hidden',
            boxSizing: 'border-box',
            zIndex: (theme) => theme.zIndex.drawer,
            boxShadow: expanded ? 4 : 'none',
            transition: (theme) =>
              theme.transitions.create('width', {
                easing: theme.transitions.easing.sharp,
                duration: theme.transitions.duration.enteringScreen,
              }),
          },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'hidden' }}>
          {renderMenuList(expanded)}
          <Divider />
        </Box>
      </Drawer>
    </Box>
  );
}
