import React from "react";

export function GlassCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-card ${className}`}>
      <div className="glass-lens" aria-hidden="true" />
      {children}
    </div>
  );
}
