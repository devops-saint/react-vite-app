import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from '@/auth';
import { DashboardLayout } from '@layouts/DashboardLayout';
import { Loader } from '@/components/common';
import { config } from '@/config';

// Lazy load pages for better performance
const LoginPage = lazy(() => import('@/pages/LoginPage').then(m => ({ default: m.LoginPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const CreateRequestPage = lazy(() => import('@/pages/CreateRequestPage').then(m => ({ default: m.CreateRequestPage })));
const MyRequestsPage = lazy(() => import('@/pages/MyRequestsPage').then(m => ({ default: m.MyRequestsPage })));
const RequestDetailsPage = lazy(() => import('@/pages/RequestDetailsPage').then(m => ({ default: m.RequestDetailsPage })));
const HelpPage = lazy(() => import('@/pages/HelpPage').then(m => ({ default: m.HelpPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));

function AppRoutes() {
  return (
    <Suspense fallback={<Loader />}>
      <Routes>
        {/* Public Routes */}
        <Route path={config.routes.login} element={<LoginPage />} />

        {/* Protected Routes with Layout */}
        <Route element={<ProtectedRoute />}>
          <Route element={<DashboardLayout />}>
            {/* Dashboard */}
            <Route path={config.routes.dashboard} element={<DashboardPage />} />

            {/* Request Management */}
            <Route path={config.routes.requestsCreate} element={<CreateRequestPage />} />
            <Route path={config.routes.requests} element={<MyRequestsPage />} />
            <Route path={config.routes.requestDetails} element={<RequestDetailsPage />} />

            {/* Help */}
            <Route path={config.routes.help} element={<HelpPage />} />

            {/* 404 Page */}
            <Route path={config.routes.notFound} element={<NotFoundPage />} />
          </Route>
        </Route>

        {/* Default redirect */}
        <Route path={config.routes.home} element={<Navigate to={config.routes.dashboard} replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

export default AppRoutes;
