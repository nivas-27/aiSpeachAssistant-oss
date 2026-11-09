import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import OtpInput from "../components/OtpInput";
import { forgotPassword, resetPassword } from "../apiCalls/endpoints";
import "./AuthPage.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_LENGTH = 6;

export default function ForgotPassword() {
  const navigate = useNavigate();

  const [step, setStep] = useState("request"); // request | reset | done
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [challenge, setChallenge] = useState(null);
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const requestCode = async (event) => {
    event?.preventDefault();

    if (!EMAIL_RE.test(email.trim())) {
      setFieldError("Enter a valid email address");
      return;
    }

    setSubmitting(true);
    setFieldError("");
    setFormError("");

    try {
      const issued = await forgotPassword(email.trim());
      setChallenge(issued);
      setResendIn(issued.resend_in_seconds || 60);
      setCode("");
      setStep("reset");
    } catch (error) {
      setFormError(error.message || "Could not send a reset code.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitReset = async (event) => {
    event.preventDefault();

    const entered = code.replace(/\s/g, "");
    if (entered.length !== OTP_LENGTH) {
      setFormError(`Enter the ${OTP_LENGTH}-digit code.`);
      return;
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setFieldError("Use at least 8 characters, with a letter and a number");
      return;
    }

    setSubmitting(true);
    setFieldError("");
    setFormError("");

    try {
      await resetPassword(email.trim(), entered, password);
      setStep("done");
    } catch (error) {
      setFormError(error.message || "Could not reset your password.");
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Done ──────────────────────────────────────────────────────────── */

  if (step === "done") {
    return (
      <div className="auth-page">
        <div className="glow auth-glow" />
        <div className="auth-card">
          <div className="auth-head">
            <span className="auth-icon-badge success material-symbols-outlined">check_circle</span>
            <h1 className="auth-title">Password changed</h1>
            <p className="auth-sub">You can sign in with your new password now.</p>
          </div>
          <button
            type="button"
            className="btn btn-primary auth-submit"
            onClick={() => navigate("/login", { replace: true })}
          >
            <span className="material-symbols-outlined">login</span>
            <span>Go to sign in</span>
          </button>
        </div>
      </div>
    );
  }

  /* ── Step 2: code + new password ───────────────────────────────────── */

  if (step === "reset") {
    return (
      <div className="auth-page">
        <div className="glow auth-glow" />

        <button type="button" className="auth-back" onClick={() => setStep("request")}>
          <span className="material-symbols-outlined">arrow_back</span>
          <span>Back</span>
        </button>

        <div className="auth-card">
          <div className="auth-head">
            <span className="auth-icon-badge material-symbols-outlined">lock_reset</span>
            <h1 className="auth-title">Set a new password</h1>
            <p className="auth-sub">
              If an account exists for <strong>{email.trim()}</strong>, a {OTP_LENGTH}-digit code
              is on its way. It expires in {challenge?.expires_in_minutes ?? 10} minutes.
            </p>
          </div>

          {challenge?.dev_code && (
            <p className="dev-code-notice">
              <span className="material-symbols-outlined">terminal</span>
              <span>
                Email delivery is not configured, so your code is{" "}
                <strong>{challenge.dev_code}</strong>. It is also printed in the backend console.
              </span>
            </p>
          )}

          <form className="auth-form" onSubmit={submitReset} noValidate>
            {formError && (
              <p className="form-alert" role="alert">
                <span className="material-symbols-outlined">error</span>
                <span>{formError}</span>
              </p>
            )}

            <OtpInput
              length={OTP_LENGTH}
              value={code}
              onChange={setCode}
              disabled={submitting}
              hasError={Boolean(formError)}
            />

            <div className="field">
              <label className="field-label" htmlFor="new-password">
                New password
              </label>
              <div className="password-wrap">
                <input
                  id="new-password"
                  className={`field-input ${fieldError ? "has-error" : ""}`}
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFieldError("");
                  }}
                  aria-invalid={Boolean(fieldError)}
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  <span className="material-symbols-outlined">
                    {showPassword ? "visibility_off" : "visibility"}
                  </span>
                </button>
              </div>
              {fieldError ? (
                <span className="field-error">{fieldError}</span>
              ) : (
                <span className="field-hint">Letters and numbers, 8 characters or more.</span>
              )}
            </div>

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="spinner" />
                  <span>Changing password…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">lock_reset</span>
                  <span>Change password</span>
                </>
              )}
            </button>
          </form>

          <p className="auth-switch">
            {resendIn > 0 ? (
              <>Did not get it? You can resend in {resendIn}s</>
            ) : (
              <>
                Did not get it?{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => requestCode()}
                  disabled={submitting}
                >
                  Send another code
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  /* ── Step 1: email ─────────────────────────────────────────────────── */

  return (
    <div className="auth-page">
      <div className="glow auth-glow" />

      <Link to="/login" className="auth-back">
        <span className="material-symbols-outlined">arrow_back</span>
        <span>Back to sign in</span>
      </Link>

      <div className="auth-card">
        <div className="auth-head">
          <span className="auth-icon-badge material-symbols-outlined">key</span>
          <h1 className="auth-title">Forgot your password?</h1>
          <p className="auth-sub">
            Enter the email you signed up with and we will send you a code to set a new password.
          </p>
        </div>

        <form className="auth-form" onSubmit={requestCode} noValidate>
          {formError && (
            <p className="form-alert" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{formError}</span>
            </p>
          )}

          <div className="field">
            <label className="field-label" htmlFor="reset-email">
              Email
            </label>
            <input
              id="reset-email"
              className={`field-input ${fieldError ? "has-error" : ""}`}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldError("");
              }}
              aria-invalid={Boolean(fieldError)}
            />
            {fieldError && <span className="field-error">{fieldError}</span>}
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner" />
                <span>Sending code…</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">mail</span>
                <span>Send reset code</span>
              </>
            )}
          </button>
        </form>

        <p className="auth-switch">
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
