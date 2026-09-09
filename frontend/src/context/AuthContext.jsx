import { useCallback, useEffect, useMemo, useState } from "react";

import { AuthContext } from "./auth-context";
import { ApiError, setToken, getToken } from "../apiCalls/client";
import { fetchMe, loginRequest, verifySignupOtp } from "../apiCalls/endpoints";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // "loading" until we know whether the stored token is still valid.
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getToken()) {
        if (!cancelled) setStatus("anonymous");
        return;
      }

      try {
        const me = await fetchMe();
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch (error) {
        if (cancelled) return;
        // A dead or expired token should not strand the user on a spinner.
        if (error instanceof ApiError && error.status === 401) setToken(null);
        setStatus("anonymous");
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyAuth = useCallback((response) => {
    setToken(response.access_token);
    setUser(response.user);
    setStatus("authenticated");
    return response.user;
  }, []);

  const login = useCallback(
    async (email, password) => applyAuth(await loginRequest({ email, password })),
    [applyAuth]
  );

  // Signup completes only once the emailed code is verified, so this is the
  // second step - the first step issues a code and creates no session.
  const completeSignup = useCallback(
    async (email, code) => applyAuth(await verifySignupOtp(email, code)),
    [applyAuth]
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: status === "authenticated",
      isLoading: status === "loading",
      login,
      completeSignup,
      logout,
    }),
    [user, status, login, completeSignup, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
