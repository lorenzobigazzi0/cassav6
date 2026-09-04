import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorFallbackRender = (args: { error: Error; reset: () => void; scope?: string }) => ReactNode;

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Optional label used for diagnostics (e.g. "app", route, or workspace name). */
  scope?: string;
  /** Optional custom fallback. Defaults to a readable card with a "Riprova" action. */
  fallback?: ErrorFallbackRender;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Route/workspace-level error boundary. Keeps a render failure from blanking the
 * whole shell and offers a "Riprova" action that reloads the page. Mounted around
 * <App/> with scope="app" in main.tsx, and reusable around individual
 * routes/workspaces.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      const label = this.props.scope ? `:${this.props.scope}` : "";
      console.error(`[ErrorBoundary${label}]`, error, info.componentStack);
    }
  }

  private reset = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset, scope: this.props.scope });
    }

    return <DefaultErrorFallback error={error} reset={this.reset} />;
  }
}

function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div
      className="page"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        className="glass-card"
        role="alert"
        aria-live="assertive"
        style={{
          maxWidth: "420px",
          width: "100%",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "18px", fontWeight: 700, marginBottom: "10px" }}>
          Qualcosa è andato storto
        </div>
        <p style={{ margin: "0 0 18px", opacity: 0.8, lineHeight: 1.45 }}>
          Si è verificato un errore imprevisto. Puoi riprovare a caricare questa sezione.
        </p>
        {import.meta.env.DEV && error.message ? (
          <pre
            style={{
              textAlign: "left",
              fontSize: "12px",
              opacity: 0.7,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              marginBottom: "18px",
            }}
          >
            {error.message}
          </pre>
        ) : null}
        <button type="button" className="btn" onClick={reset}>
          Riprova
        </button>
      </div>
    </div>
  );
}
