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
const ProfilePage = lazy(() => import('@/pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const CurrentWhitelistPage = lazy(() => import('@/pages/CurrentWhitelistPage').then(m => ({ default: m.CurrentWhitelistPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));

function AppRoutes() {
  // Deliberately no single Suspense wrapping the whole <Routes> tree: that
  // used to mean navigating to a page whose lazy chunk hadn't loaded yet
  // (e.g. right after a hard refresh) suspended everything under it,
  // including DashboardLayout - unmounting Header/Sidebar and discarding
  // whatever state update was batched into that same navigation (this is
  // exactly what made the hamburger menu's onClose() appear to not take
  // effect on the first click after a refresh: React 18 batches the
  // sidebar-close setState with the navigate()-triggered one, and neither
  // commits until the suspended chunk finishes loading). Each layout now
  // owns its own local Suspense boundary around just its routed content
  // instead, so a page's lazy chunk loading never unmounts its ancestors.
  return (
    <Routes>
      {/* Public Routes */}
      <Route
        path={config.routes.login}
        element={
          <Suspense fallback={<Loader />}>
            <LoginPage />
          </Suspense>
        }
      />

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

          {/* Current Whitelist */}
          <Route path={config.routes.whitelist} element={<CurrentWhitelistPage />} />

          {/* Account */}
          <Route path={config.routes.profile} element={<ProfilePage />} />
          <Route path={config.routes.settings} element={<SettingsPage />} />

          {/* 404 Page - covered by DashboardLayout's own Suspense boundary
              around its <Outlet />, same as every other nested route here */}
          <Route path={config.routes.notFound} element={<NotFoundPage />} />
        </Route>
      </Route>

      {/* Default redirect */}
      <Route path={config.routes.home} element={<Navigate to={config.routes.dashboard} replace />} />
      <Route
        path="*"
        element={
          <Suspense fallback={<Loader />}>
            <NotFoundPage />
          </Suspense>
        }
      />
    </Routes>
  );
}

export default AppRoutes;
