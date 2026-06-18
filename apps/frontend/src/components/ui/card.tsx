import { HTMLAttributes, forwardRef } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', hoverable = false, children, ...props }, ref): JSX.Element => {
    const baseStyle =
      'rounded-xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm transition-all duration-200';
    const hoverStyle = hoverable
      ? 'hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 hover:-translate-y-0.5'
      : '';

    return (
      <div ref={ref} className={`${baseStyle} ${hoverStyle} ${className}`} {...props}>
        {children}
      </div>
    );
  }
);
Card.displayName = 'Card';

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = '', children, ...props }, ref): JSX.Element => {
    return (
      <div ref={ref} className={`flex flex-col gap-1.5 p-6 ${className}`} {...props}>
        {children}
      </div>
    );
  }
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className = '', children, ...props }, ref): JSX.Element => {
    return (
      <h3
        ref={ref}
        className={`text-lg md:text-xl font-semibold leading-none tracking-tight text-slate-900 dark:text-slate-100 ${className}`}
        {...props}
      >
        {children}
      </h3>
    );
  }
);
CardTitle.displayName = 'CardTitle';

export const CardDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className = '', children, ...props }, ref): JSX.Element => {
  return (
    <p
      ref={ref}
      className={`text-xs md:text-sm text-slate-500 dark:text-slate-400 ${className}`}
      {...props}
    >
      {children}
    </p>
  );
});
CardDescription.displayName = 'CardDescription';

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = '', children, ...props }, ref): JSX.Element => {
    return (
      <div
        ref={ref}
        className={`p-6 pt-0 text-slate-700 dark:text-slate-350 text-sm md:text-base ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CardContent.displayName = 'CardContent';

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = '', children, ...props }, ref): JSX.Element => {
    return (
      <div
        ref={ref}
        className={`flex items-center p-6 pt-0 border-t border-slate-100/50 dark:border-slate-800/50 mt-6 pt-4 ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CardFooter.displayName = 'CardFooter';
