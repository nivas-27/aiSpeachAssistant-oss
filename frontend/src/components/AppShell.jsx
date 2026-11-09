import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

import { useAuth } from "../context/auth-context";
import "./AppShell.css";

const NAV_ITEMS = [
  { to: "/app", label: "Home", icon: "home", end: true },
  { to: "/app/practice", label: "Practice", icon: "graphic_eq" },
  { to: "/app/reports", label: "Reports", icon: "monitoring" },
];

function initialsOf(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function AppShell({ children, bare = false }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <div className="shell">
      {!bare && (
      <header className="shell-nav">
        <NavLink to="/app" className="shell-brand" end>
          <span className="shell-brand-dot" />
          <span className="shell-brand-name">Fluently</span>
        </NavLink>

        <nav className="shell-links" aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `shell-link ${isActive ? "is-active" : ""}`}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="shell-account" ref={menuRef}>
          <button
            type="button"
            className="shell-avatar-btn"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account menu"
          >
            <span className="shell-avatar">{initialsOf(user?.full_name)}</span>
            <span className="shell-account-name">{user?.full_name?.split(" ")[0]}</span>
            <span className="material-symbols-outlined shell-caret">expand_more</span>
          </button>

          {menuOpen && (
            <div className="shell-menu" role="menu">
              <div className="shell-menu-head">
                <p className="shell-menu-name">{user?.full_name}</p>
                <p className="shell-menu-email">{user?.email}</p>
              </div>
              <button type="button" className="shell-menu-item" role="menuitem" onClick={handleLogout}>
                <span className="material-symbols-outlined">logout</span>
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </header>
      )}

      {/* The children subtree keeps the same position whether or not the
          chrome is showing, so toggling `bare` never remounts the page. */}
      <main className={`shell-body ${bare ? "shell-body-bare" : ""}`}>{children}</main>

      {!bare && (
      <nav className="shell-tabbar" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `shell-tab ${isActive ? "is-active" : ""}`}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      )}
    </div>
  );
}
