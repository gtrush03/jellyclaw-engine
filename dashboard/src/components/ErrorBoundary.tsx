import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error("ErrorBoundary caught:", error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="glass max-w-lg w-full p-8 rounded-lg">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-[color:var(--color-danger)]" />
              <div>
                <h1 className="text-lg font-semibold text-[color:var(--color-gold-bright)] mb-1">
                  Something broke
                </h1>
                <p className="text-sm text-[color:var(--color-text-muted)]">
                  The dashboard hit an unexpected error. The backend may be restarting.
                </p>
              </div>
            </div>
            <pre className="font-mono text-xs p-3 bg-[color:var(--color-gold-faint)] border hairline rounded overflow-auto max-h-60 text-[color:var(--color-text-muted)]">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
            </pre>
            <button
              type="button"
              onClick={this.reset}
              className="mt-4 px-4 py-2 rounded border hairline text-[color:var(--color-gold-bright)] hover:bg-[color:var(--color-gold-faint)] transition-colors text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
