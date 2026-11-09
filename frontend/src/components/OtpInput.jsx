import { useEffect, useRef } from "react";

import "./OtpInput.css";

/**
 * Six separate boxes that behave like one field: typing advances, backspace
 * retreats, arrows move, and a pasted code fills every box at once.
 */
export default function OtpInput({ length = 6, value, onChange, onComplete, disabled, hasError }) {
  const inputsRef = useRef([]);

  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  const digits = value.padEnd(length, " ").slice(0, length).split("");

  const setDigit = (index, digit) => {
    const next = digits.map((d, i) => (i === index ? digit : d)).join("").trimEnd();
    onChange(next);
    return next;
  };

  const handleChange = (index) => (event) => {
    const typed = event.target.value.replace(/\D/g, "");
    if (!typed) return;

    // Typing over a filled box, or pasting several digits at once.
    if (typed.length > 1) {
      const filled = (value + typed).replace(/\s/g, "").slice(0, length);
      onChange(filled);
      const focusAt = Math.min(filled.length, length - 1);
      inputsRef.current[focusAt]?.focus();
      if (filled.length === length) onComplete?.(filled);
      return;
    }

    const next = setDigit(index, typed);
    if (index < length - 1) inputsRef.current[index + 1]?.focus();
    if (next.replace(/\s/g, "").length === length) onComplete?.(next);
  };

  const handleKeyDown = (index) => (event) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (digits[index] !== " " && digits[index] !== "") {
        setDigit(index, " ");
      } else if (index > 0) {
        setDigit(index - 1, " ");
        inputsRef.current[index - 1]?.focus();
      }
      return;
    }

    if (event.key === "ArrowLeft" && index > 0) inputsRef.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < length - 1) inputsRef.current[index + 1]?.focus();
  };

  const handlePaste = (event) => {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    event.preventDefault();
    onChange(pasted);
    inputsRef.current[Math.min(pasted.length, length - 1)]?.focus();
    if (pasted.length === length) onComplete?.(pasted);
  };

  return (
    <div className={`otp-input ${hasError ? "has-error" : ""}`} onPaste={handlePaste}>
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            inputsRef.current[index] = element;
          }}
          className="otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={digits[index]?.trim() || ""}
          onChange={handleChange(index)}
          onKeyDown={handleKeyDown(index)}
          onFocus={(event) => event.target.select()}
          disabled={disabled}
          aria-label={`Digit ${index + 1} of ${length}`}
        />
      ))}
    </div>
  );
}
