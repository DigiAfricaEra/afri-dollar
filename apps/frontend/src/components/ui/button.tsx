import { ButtonHTMLAttributes, ReactNode, forwardRef } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const Spinner = () => (
  <svg
    className="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    data-testid="button-spinner"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'md',
      loading = false,
      leftIcon,
      rightIcon,
      className = '',
      type = 'button',
      disabled,
      ...props
    },
    ref
  ): JSX.Element => {
    const baseStyle =
      'inline-flex items-center justify-center font-semibold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 select-none';

    const sizes = {
      sm: 'px-3 py-1.5 text-xs md:text-sm rounded-md',
      md: 'px-4 py-2 text-sm md:text-base rounded-md',
      lg: 'px-5 py-2.5 text-base md:text-lg rounded-md',
    };

    const variants = {
      primary:
        'bg-primary-600 text-white hover:bg-primary-700 active:bg-primary-800 focus-visible:ring-primary-500 shadow-sm border border-transparent',
      secondary:
        'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 focus-visible:ring-slate-500 border border-transparent',
      outline:
        'border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 active:bg-slate-100 dark:active:bg-slate-900 focus-visible:ring-slate-500',
      danger:
        'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 focus-visible:ring-red-500 shadow-sm border border-transparent',
      ghost:
        'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 active:bg-slate-100 dark:active:bg-slate-900 focus-visible:ring-slate-500',
    };

    const isBtnDisabled = disabled || loading;
    const variantClass = variants[variant] || variants.primary;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isBtnDisabled}
        aria-busy={loading}
        className={`${baseStyle} ${sizes[size]} ${variantClass} ${className}`}
        {...props}
      >
        {loading && <Spinner />}
        {!loading && leftIcon && <span className="mr-2 inline-flex">{leftIcon}</span>}
        {children}
        {!loading && rightIcon && <span className="ml-2 inline-flex">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
