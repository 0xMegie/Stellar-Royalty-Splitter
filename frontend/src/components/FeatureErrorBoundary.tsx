import React, { ReactNode, FC, ErrorInfo } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

interface FeatureErrorBoundaryProps {
  children: ReactNode;
  featureName: string;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * Feature-level error boundary that isolates errors to specific features/pages
 * Prevents one feature failure from breaking the entire application
 */
export const FeatureErrorBoundary: FC<FeatureErrorBoundaryProps> = ({
  children,
  featureName,
  fallback,
  onError,
}) => {
  return (
    <ErrorBoundary
      level="feature"
      fallback={
        fallback || (
          <div className="feature-error-fallback">
            <div className="feature-error-content">
              <h2>Feature Unavailable</h2>
              <p>
                The {featureName} feature encountered an error. Please try again
                or check back later.
              </p>
            </div>
          </div>
        )
      }
      onError={(error, errorInfo) => {
        if (onError) {
          onError(error, errorInfo);
        }
      }}
    >
      {children}
    </ErrorBoundary>
  );
};
