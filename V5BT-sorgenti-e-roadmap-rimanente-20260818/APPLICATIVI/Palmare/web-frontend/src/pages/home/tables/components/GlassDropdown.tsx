import { useEffect, useMemo, useRef, useState } from "react";

export type GlassDropdownOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

interface GlassDropdownProps {
  value: string;
  options: GlassDropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  closeOnSelect?: boolean;
}

export function GlassDropdown({
  value,
  options,
  onChange,
  placeholder = "Seleziona...",
  ariaLabel,
  disabled = false,
  className = "",
  closeOnSelect = true,
}: GlassDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (rootRef.current?.contains(node)) return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      className={`table-glass-dropdown ${open ? "is-open" : ""} ${className}`.trim()}
      ref={rootRef}
    >
      <button
        type="button"
        className={`table-glass-dropdown-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="table-glass-dropdown-label">{selectedOption?.label ?? placeholder}</span>
        <svg className="table-glass-dropdown-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && !disabled && (
        <div className="table-glass-dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.length === 0 ? (
            <div
              className="table-glass-dropdown-option is-empty"
              role="option"
              aria-selected="false"
            >
              Nessuna opzione disponibile
            </div>
          ) : (
            options.map((option) => {
              const isSelected = option.value === value;
              const isDisabled = Boolean(option.disabled);
              return (
                <button
                  key={option.value || "__empty_option"}
                  type="button"
                  className={`table-glass-dropdown-option ${isSelected ? "is-selected" : ""} ${isDisabled ? "is-disabled" : ""}`}
                  role="option"
                  aria-selected={isSelected}
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    if (closeOnSelect) {
                      setOpen(false);
                    }
                    onChange(option.value);
                  }}
                >
                  <span>{option.label}</span>
                  {isSelected ? (
                    <svg
                      className="table-glass-dropdown-check"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
