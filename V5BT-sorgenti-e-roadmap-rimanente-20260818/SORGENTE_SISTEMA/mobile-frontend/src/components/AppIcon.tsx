import { useEffect, useState } from "react";
import type { ReactNode } from "react";

interface AppIconProps {
  src: string;
  fallback: ReactNode;
  className?: string;
  alt?: string;
  decorative?: boolean;
}

export function AppIcon({ src, fallback, className, alt, decorative = true }: AppIconProps) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (hasError) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={src}
      alt={decorative ? "" : alt || ""}
      aria-hidden={decorative}
      className={className ? `app-icon-img ${className}` : "app-icon-img"}
      draggable={false}
      onError={() => setHasError(true)}
      onLoad={(e) => {
        // Empty or invalid files can load without throwing; fallback to inline icon.
        if (e.currentTarget.naturalWidth === 0 || e.currentTarget.naturalHeight === 0) {
          setHasError(true);
        }
      }}
    />
  );
}
