import { SelectHTMLAttributes, forwardRef, useId } from 'react';

export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helperText?: string;
  options?: SelectOption[];
  fullWidth?: boolean;
}

const ChevronDownIcon = () => (
  <svg
    className="h-5 w-5 text-slate-500 dark:text-slate-400"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
      clipRule="evenodd"
    />
  </svg>
);

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      error,
      helperText,
      options = [],
      fullWidth = true,
      className = '',
      children,
      disabled,
      required,
      id: customId,
      ...props
    },
    ref
  ): JSX.Element => {
    const generatedId = useId();
    const id = customId || generatedId;
    const errorId = `${id}-error`;
    const helperId = `${id}-helper`;

    const wrapperClass = `${fullWidth ? 'w-full' : 'w-auto'} flex flex-col gap-1.5`;

    const selectBaseClass =
      'block w-full rounded-md border bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-offset-0 transition-all duration-200 disabled:cursor-not-allowed disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-400 text-sm md:text-base appearance-none pr-10 pl-3.5 py-2';

    const selectVariantClass = error
      ? 'border-red-500 focus:border-red-500 focus:ring-red-500 dark:border-red-600'
      : 'border-slate-300 dark:border-slate-700 focus:border-primary-500 focus:ring-primary-500';

    return (
      <div className={wrapperClass}>
        {label && (
          <label
            htmlFor={id}
            className="text-sm font-medium text-slate-700 dark:text-slate-300 select-none"
          >
            {label}
            {required && (
              <span className="text-red-500 ml-1" data-testid="select-required">
                *
              </span>
            )}
          </label>
        )}

        <div className="relative rounded-md shadow-sm">
          <select
            ref={ref}
            id={id}
            disabled={disabled}
            required={required}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={error ? errorId : helperText ? helperId : undefined}
            className={`${selectBaseClass} ${selectVariantClass} ${className}`}
            {...props}
          >
            {children
              ? children
              : options.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  >
                    {option.label}
                  </option>
                ))}
          </select>

          <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
            <ChevronDownIcon />
          </div>
        </div>

        {error && (
          <p
            id={errorId}
            className="text-xs md:text-sm text-red-600 dark:text-red-400 font-medium"
            data-testid="select-error"
          >
            {error}
          </p>
        )}

        {!error && helperText && (
          <p
            id={helperId}
            className="text-xs md:text-sm text-slate-500 dark:text-slate-400"
            data-testid="select-helper"
          >
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
