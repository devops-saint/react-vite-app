import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Box, Container, Toolbar } from '@mui/material';
import { Header } from '@components/Header';
import { Sidebar } from '@components/Sidebar';
import { Footer } from '@components/Footer';
import { Breadcrumbs } from '@components/Breadcrumbs';

export function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleSidebarToggle = () => {
    setSidebarOpen(!sidebarOpen);
  };

  const handleSidebarClose = () => {
    setSidebarOpen(false);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Header onMenuClick={handleSidebarToggle} />
      <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          bgcolor: 'background.default',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Toolbar />
        <Container
          maxWidth="xl"
          sx={{
            mt: 3,
            mb: 3,
            flexGrow: 1,
          }}
        >
          <Breadcrumbs />
          <Outlet />
        </Container>
      </Box>

      <Footer />
    </Box>
  );
}
