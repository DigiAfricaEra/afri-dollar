import { InputHTMLAttributes, ReactNode, forwardRef, useId } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftAdornment?: ReactNode;
  rightAdornment?: ReactNode;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      leftAdornment,
      rightAdornment,
      fullWidth = true,
      className = '',
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

    const inputBaseClass =
      'block w-full rounded-md border text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-offset-0 transition-all duration-200 disabled:cursor-not-allowed disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-400 text-sm md:text-base';

    const inputVariantClass = error
      ? 'border-red-500 focus:border-red-500 focus:ring-red-500 dark:border-red-600'
      : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:border-primary-500 focus:ring-primary-500';

    const paddingClass = `${leftAdornment ? 'pl-10' : 'pl-3.5'} ${rightAdornment ? 'pr-10' : 'pr-3.5'} py-2`;

    return (
      <div className={wrapperClass}>
        {label && (
          <label
            htmlFor={id}
            className="text-sm font-medium text-slate-700 dark:text-slate-300 select-none"
          >
            {label}
            {required && (
              <span className="text-red-500 ml-1" data-testid="input-required">
                *
              </span>
            )}
          </label>
        )}

        <div className="relative rounded-md shadow-sm">
          {leftAdornment && (
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 dark:text-slate-400">
              {leftAdornment}
            </div>
          )}

          <input
            ref={ref}
            id={id}
            disabled={disabled}
            required={required}
            aria-invalid={error ? 'true' : 'false'}
            aria-describedby={error ? errorId : helperText ? helperId : undefined}
            className={`${inputBaseClass} ${inputVariantClass} ${paddingClass} ${className}`}
            {...props}
          />

          {rightAdornment && (
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 dark:text-slate-400">
              {rightAdornment}
            </div>
          )}
        </div>

        {error && (
          <p
            id={errorId}
            className="text-xs md:text-sm text-red-600 dark:text-red-400 font-medium"
            data-testid="input-error"
          >
            {error}
          </p>
        )}

        {!error && helperText && (
          <p
            id={helperId}
            className="text-xs md:text-sm text-slate-500 dark:text-slate-400"
            data-testid="input-helper"
          >
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
