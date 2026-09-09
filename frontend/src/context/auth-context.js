import { createContext, useContext } from "react";

/* Kept in a component-free module so React Fast Refresh can still hot-reload
   the provider that lives next door. */
export const AuthContext = createContext(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}
