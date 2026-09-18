import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Box, Container, Toolbar } from '@mui/material';
import { Header } from '@components/Header';
import { Sidebar } from '@components/Sidebar';
import { Footer } from '@components/Footer';
import { Breadcrumbs } from '@components/Breadcrumbs';
import { IntegrationDisclaimer } from '@components/IntegrationDisclaimer';
import { Loader } from '@/components/common';

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

      {/* Row below the fixed Header: Sidebar sits permanently in-flow on
          desktop (md+) and pushes this row's content over, instead of
          floating above it as a dismissible overlay. */}
      <Box sx={{ display: 'flex', flexGrow: 1 }}>
        <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />

        <Box
          component="main"
          sx={{
            flexGrow: 1,
            minWidth: 0,
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
            <IntegrationDisclaimer />
            <Breadcrumbs />
            <Suspense fallback={<Loader />}>
              <Outlet />
            </Suspense>
          </Container>
        </Box>
      </Box>

      <Footer />
    </Box>
  );
}
