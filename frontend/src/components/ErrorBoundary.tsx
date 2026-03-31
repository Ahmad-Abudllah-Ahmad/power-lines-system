import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-6">
          <div className="glass rounded-2xl border border-premium-danger/50 bg-premium-danger/10 p-8 max-w-2xl w-full shadow-premium">
            <div className="flex items-center gap-4 mb-6">
              <AlertCircle className="text-4xl text-red-400" size={40} />
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">Something went wrong</h1>
                <p className="text-neutral-400">
                  An unexpected error occurred. Please try refreshing the page.
                </p>
              </div>
            </div>

            {this.state.error && (
              <div className="mb-6 p-4 bg-neutral-900/50 rounded-lg border border-neutral-700">
                <div className="text-sm font-semibold text-premium-danger mb-2">Error Details:</div>
                <div className="text-xs text-neutral-300 font-mono break-all">
                  {this.state.error.toString()}
                </div>
                {this.state.errorInfo && (
                  <details className="mt-3">
                    <summary className="text-xs text-neutral-400 cursor-pointer hover:text-neutral-300">
                      Stack Trace
                    </summary>
                    <pre className="mt-2 text-xs text-neutral-500 overflow-auto max-h-40">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-lg bg-premium-accent text-white font-semibold hover:bg-premium-accent/80 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-neutral-700 text-white font-semibold hover:bg-neutral-600 transition-colors"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

