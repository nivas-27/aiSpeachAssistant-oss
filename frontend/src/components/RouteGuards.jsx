import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "../context/auth-context";

function FullPageLoader() {
  return (
    <div className="route-loader" role="status" aria-live="polite">
      <span className="spinner spinner-light" />
      <span>Loading…</span>
    </div>
  );
}

/** Blocks a route until a valid session exists, remembering where to return. */
export function RequireAuth({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageLoader />;

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return children;
}

/** Keeps signed-in users out of the landing/login/signup pages. */
export function RedirectIfAuthed({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <FullPageLoader />;
  if (isAuthenticated) return <Navigate to="/app" replace />;

  return children;
}
