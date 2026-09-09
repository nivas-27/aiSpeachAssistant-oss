import { Navigate, Route, Routes } from "react-router-dom";

import AppShell from "./components/AppShell";
import { RedirectIfAuthed, RequireAuth } from "./components/RouteGuards";
import { AuthProvider } from "./context/AuthContext";
import AuthPage from "./pages/AuthPage";
import ForgotPassword from "./pages/ForgotPassword";
import Home from "./pages/Home";
import Landing from "./pages/Landing";
import Practice from "./pages/Practice";
import Reports from "./pages/Reports";
import "./App.css";

/** Wraps a page in the signed-in chrome (top nav + mobile tab bar). */
function Shelled({ children }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

function NotFound() {
  return (
    <div className="not-found">
      <h1>404</h1>
      <p>That page does not exist.</p>
      <a className="btn btn-primary" href="/">
        Back to home
      </a>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route
          path="/"
          element={
            <RedirectIfAuthed>
              <Landing />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <AuthPage mode="login" />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/signup"
          element={
            <RedirectIfAuthed>
              <AuthPage mode="signup" />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <RedirectIfAuthed>
              <ForgotPassword />
            </RedirectIfAuthed>
          }
        />

        {/* Signed in */}
        <Route
          path="/app"
          element={
            <Shelled>
              <Home />
            </Shelled>
          }
        />
        <Route
          path="/app/reports"
          element={
            <Shelled>
              <Reports />
            </Shelled>
          }
        />

        {/* The practice room is full-bleed, so it skips the shell body. */}
        <Route
          path="/app/practice"
          element={
            <RequireAuth>
              <Practice />
            </RequireAuth>
          }
        />

        <Route path="/app/*" element={<Navigate to="/app" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
