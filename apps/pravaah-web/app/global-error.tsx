"use client";

import type { ReactElement } from "react";

/**
 * Global error replaces the root layout, so it renders its own html/body and
 * cannot rely on the font variables or the stylesheet being present. Styles are
 * inline for that reason, using the same palette values as globals.css.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          backgroundColor: "#0e3b2e",
          color: "#eeefe7",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: "34rem", padding: "3rem 1.5rem" }}>
          <p
            style={{
              margin: 0,
              fontSize: "0.6875rem",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#b08434",
            }}
          >
            Press failure
          </p>

          <h1
            style={{
              margin: "1.75rem 0 0",
              fontSize: "2rem",
              fontWeight: 500,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            Something failed before the page could load.
          </h1>

          <p
            style={{
              margin: "1.5rem 0 0",
              fontSize: "1rem",
              lineHeight: 1.7,
              color: "#a8c4b6",
            }}
          >
            This site holds none of your data, so nothing about your account or
            your consents is affected. Reloading usually resolves it.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "2.5rem",
              padding: "0.875rem 1.5rem",
              border: "none",
              cursor: "pointer",
              backgroundColor: "#eeefe7",
              color: "#082018",
              fontSize: "0.6875rem",
              fontWeight: 600,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
