import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import OtpInput from "../components/OtpInput";
import { useAuth } from "../context/auth-context";
import { requestSignupOtp, resendSignupOtp } from "../apiCalls/endpoints";
import "./AuthPage.css";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_LENGTH = 6;

function validate(mode, values) {
  const errors = {};

  if (mode === "signup" && values.fullName.trim().length < 2) {
    errors.fullName = "Enter your name";
  }

  if (!EMAIL_RE.test(values.email.trim())) {
    errors.email = "Enter a valid email address";
  }

  if (mode === "signup") {
    if (values.password.length < 8) {
      errors.password = "At least 8 characters";
    } else if (!/[a-zA-Z]/.test(values.password) || !/\d/.test(values.password)) {
      errors.password = "Use at least one letter and one number";
    }
  } else if (!values.password) {
    errors.password = "Enter your password";
  }

  return errors;
}

export default function AuthPage({ mode }) {
  const isSignup = mode === "signup";
  const { login, completeSignup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState("details"); // details | otp
  const [values, setValues] = useState({ fullName: "", email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);

  // Counts the resend cooldown down to zero.
  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const setField = (name) => (event) => {
    setValues((previous) => ({ ...previous, [name]: event.target.value }));
    setErrors((previous) => ({ ...previous, [name]: undefined }));
    setFormError("");
  };

  const handleDetailsSubmit = async (event) => {
    event.preventDefault();

    const found = validate(mode, values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSubmitting(true);
    setFormError("");

    try {
      if (isSignup) {
        // Sends a code and parks the details server-side until it is verified.
        const issued = await requestSignupOtp({
          full_name: values.fullName.trim(),
          email: values.email.trim(),
          password: values.password,
        });
        setChallenge(issued);
        setResendIn(issued.resend_in_seconds || 60);
        setCode("");
        setStep("otp");
      } else {
        await login(values.email.trim(), values.password);
        navigate(location.state?.from || "/app", { replace: true });
      }
    } catch (error) {
      setFormError(error.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = useCallback(
    async (candidate) => {
      const entered = (candidate ?? code).replace(/\s/g, "");
      if (entered.length !== OTP_LENGTH) {
        setFormError(`Enter the ${OTP_LENGTH}-digit code.`);
        return;
      }

      setSubmitting(true);
      setFormError("");

      try {
        await completeSignup(values.email.trim(), entered);
        navigate(location.state?.from || "/app", { replace: true });
      } catch (error) {
        setFormError(error.message || "Could not verify that code.");
        setCode("");
      } finally {
        setSubmitting(false);
      }
    },
    [code, completeSignup, values.email, navigate, location.state]
  );

  const handleResend = async () => {
    setSubmitting(true);
    setFormError("");
    try {
      const issued = await resendSignupOtp(values.email.trim());
      setChallenge(issued);
      setResendIn(issued.resend_in_seconds || 60);
      setCode("");
    } catch (error) {
      setFormError(error.message || "Could not send another code.");
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Step 2: code entry ────────────────────────────────────────────── */

  if (isSignup && step === "otp") {
    return (
      <div className="auth-page">
        <div className="glow auth-glow" />

        <button type="button" className="auth-back" onClick={() => setStep("details")}>
          <span className="material-symbols-outlined">arrow_back</span>
          <span>Back</span>
        </button>

        <div className="auth-card">
          <div className="auth-head">
            <span className="auth-icon-badge material-symbols-outlined">mark_email_read</span>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-sub">
              We sent a {OTP_LENGTH}-digit code to <strong>{values.email.trim()}</strong>. It
              expires in {challenge?.expires_in_minutes ?? 10} minutes.
            </p>
          </div>

          {challenge?.dev_code && (
            <p className="dev-code-notice">
              <span className="material-symbols-outlined">terminal</span>
              <span>
                Email delivery is not configured, so your code is{" "}
                <strong>{challenge.dev_code}</strong>. It is also printed in the backend
                console.
              </span>
            </p>
          )}

          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitCode();
            }}
            noValidate
          >
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
              onComplete={submitCode}
              disabled={submitting}
              hasError={Boolean(formError)}
            />

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="spinner" />
                  <span>Verifying…</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">check</span>
                  <span>Verify and create account</span>
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
                  onClick={handleResend}
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

  /* ── Step 1: details / login ───────────────────────────────────────── */

  return (
    <div className="auth-page">
      <div className="glow auth-glow" />

      <Link to="/" className="auth-back">
        <span className="material-symbols-outlined">arrow_back</span>
        <span>Back</span>
      </Link>

      <div className="auth-card">
        <div className="auth-head">
          <span className="auth-icon-badge material-symbols-outlined">mail</span>
          <h1 className="auth-title">{isSignup ? "Create your account" : "Welcome back"}</h1>
          <p className="auth-sub">
            {isSignup
              ? "We will email you a code to confirm it is really you."
              : "Sign in to continue your practice."}
          </p>
        </div>

        <form className="auth-form" onSubmit={handleDetailsSubmit} noValidate>
          {formError && (
            <p className="form-alert" role="alert">
              <span className="material-symbols-outlined">error</span>
              <span>{formError}</span>
            </p>
          )}

          {isSignup && (
            <div className="field">
              <label className="field-label" htmlFor="fullName">
                Full name
              </label>
              <input
                id="fullName"
                name="name"
                className={`field-input ${errors.fullName ? "has-error" : ""}`}
                type="text"
                autoComplete="name"
                placeholder="Priya Sharma"
                value={values.fullName}
                onChange={setField("fullName")}
                aria-invalid={Boolean(errors.fullName)}
              />
              {errors.fullName && <span className="field-error">{errors.fullName}</span>}
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              className={`field-input ${errors.email ? "has-error" : ""}`}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={values.email}
              onChange={setField("email")}
              aria-invalid={Boolean(errors.email)}
            />
            {errors.email && <span className="field-error">{errors.email}</span>}
          </div>

          <div className="field">
            <div className="field-label-row">
              <label className="field-label" htmlFor="password">
                Password
              </label>
              {!isSignup && (
                <Link to="/forgot-password" className="field-link">
                  Forgot password?
                </Link>
              )}
            </div>
            <div className="password-wrap">
              <input
                id="password"
                name="password"
                className={`field-input ${errors.password ? "has-error" : ""}`}
                type={showPassword ? "text" : "password"}
                autoComplete={isSignup ? "new-password" : "current-password"}
                placeholder={isSignup ? "At least 8 characters" : "Your password"}
                value={values.password}
                onChange={setField("password")}
                aria-invalid={Boolean(errors.password)}
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
            {errors.password ? (
              <span className="field-error">{errors.password}</span>
            ) : (
              isSignup && (
                <span className="field-hint">Letters and numbers, 8 characters or more.</span>
              )
            )}
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner" />
                <span>{isSignup ? "Sending code…" : "Signing in…"}</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">{isSignup ? "mail" : "login"}</span>
                <span>{isSignup ? "Send verification code" : "Sign in"}</span>
              </>
            )}
          </button>
        </form>

        <p className="auth-switch">
          {isSignup ? "Already have an account?" : "New here?"}{" "}
          <Link to={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </div>
    </div>
  );
}
