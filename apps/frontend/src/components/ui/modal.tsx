import { MouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEsc?: boolean;
  children: ReactNode;
  className?: string;
  ariaLabelledBy?: string;
}

export function ModalHeader({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`px-6 py-4 border-b border-slate-150 dark:border-slate-800 flex justify-between items-center ${className}`}
    >
      {children}
    </div>
  );
}

export function ModalTitle({
  children,
  className = '',
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}): JSX.Element {
  return (
    <h2 id={id} className={`text-lg font-bold text-slate-900 dark:text-slate-100 ${className}`}>
      {children}
    </h2>
  );
}

export function ModalBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`px-6 py-4 text-slate-600 dark:text-slate-350 text-sm md:text-base ${className}`}
    >
      {children}
    </div>
  );
}

export function ModalFooter({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`px-6 py-4 border-t border-slate-150 dark:border-slate-800 flex justify-end gap-3 bg-slate-50 dark:bg-slate-950/40 rounded-b-lg ${className}`}
    >
      {children}
    </div>
  );
}

export function Modal({
  isOpen,
  onClose,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEsc = true,
  children,
  className = '',
  ariaLabelledBy,
}: ModalProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Lock scroll
  useEffect(() => {
    if (!isOpen) return;
    const originalStyle = window.getComputedStyle(document.body).overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closeOnEsc, onClose]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;
    const modalEl = modalRef.current;
    if (!modalEl) return;

    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    // Focus on first focusable element
    const timeoutId = setTimeout(() => {
      const focusableElements = modalEl.querySelectorAll(focusableSelector);
      if (focusableElements.length > 0) {
        (focusableElements[0] as HTMLElement).focus();
      }
    }, 50);

    const handleFocusTrap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusableElements = modalEl.querySelectorAll(focusableSelector);
      if (focusableElements.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusableElements[0] as HTMLElement;
      const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    };

    document.addEventListener('keydown', handleFocusTrap);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('keydown', handleFocusTrap);
    };
  }, [isOpen]);

  if (!isOpen || !mounted) return null;

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full m-4 h-[calc(100vh-2rem)]',
  };

  const handleOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnOverlayClick && e.target === e.currentTarget) {
      onClose();
    }
  };

  const modalRoot = document.getElementById('modal-root') || document.body;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-sm transition-opacity duration-300"
      onClick={handleOverlayClick}
      data-testid="modal-overlay"
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        className={`w-full bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-lg shadow-xl flex flex-col scale-95 transition-transform duration-300 ease-out max-h-[90vh] overflow-y-auto ${sizeClasses[size]} ${className}`}
        data-testid="modal-container"
      >
        {children}
      </div>
    </div>,
    modalRoot
  );
}
