import '@testing-library/jest-dom';

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

import { Avatar } from '../src/components/ui/avatar';
import { Button } from '../src/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../src/components/ui/card';
import { Input } from '../src/components/ui/input';
import { Modal, ModalBody, ModalFooter, ModalHeader, ModalTitle } from '../src/components/ui/modal';
import { Select } from '../src/components/ui/select';

describe('UI Component Library Tests', () => {
  // ==========================================
  // Button Component Tests
  // ==========================================
  describe('Button Component', () => {
    it('renders with children', () => {
      render(<Button>Click Me</Button>);
      expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
    });

    it('applies sizes and variants correctly', () => {
      const { rerender } = render(
        <Button size="sm" variant="danger">
          Btn
        </Button>
      );
      let button = screen.getByRole('button');
      expect(button).toHaveClass('px-3');
      expect(button).toHaveClass('bg-red-600');

      rerender(
        <Button size="lg" variant="outline">
          Btn
        </Button>
      );
      button = screen.getByRole('button');
      expect(button).toHaveClass('px-5');
      expect(button).toHaveClass('border-slate-300');
    });

    it('handles loading state', () => {
      render(<Button loading>Btn</Button>);
      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('button-spinner')).toBeInTheDocument();
    });

    it('renders left and right icons', () => {
      render(
        <Button
          leftIcon={<span data-testid="left-icon">L</span>}
          rightIcon={<span data-testid="right-icon">R</span>}
        >
          Btn
        </Button>
      );
      expect(screen.getByTestId('left-icon')).toBeInTheDocument();
      expect(screen.getByTestId('right-icon')).toBeInTheDocument();
    });

    it('supports ref forwarding', () => {
      const ref = createRef<HTMLButtonElement>();
      render(<Button ref={ref}>Btn</Button>);
      expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    });
  });

  // ==========================================
  // Input Component Tests
  // ==========================================
  describe('Input Component', () => {
    it('renders label and input correctly', () => {
      render(<Input label="Username" placeholder="Enter username" />);
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    });

    it('displays error message and sets aria-invalid', () => {
      render(<Input label="Email" error="Invalid email address" />);
      const errorMsg = screen.getByTestId('input-error');
      expect(errorMsg).toBeInTheDocument();
      expect(errorMsg).toHaveTextContent('Invalid email address');
      expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    });

    it('displays helper text when no error exists', () => {
      render(<Input label="Password" helperText="Must be 8+ chars" />);
      const helper = screen.getByTestId('input-helper');
      expect(helper).toBeInTheDocument();
      expect(helper).toHaveTextContent('Must be 8+ chars');
    });

    it('renders left and right adornments', () => {
      render(
        <Input
          leftAdornment={<span data-testid="left-ad">Prefix</span>}
          rightAdornment={<span data-testid="right-ad">Suffix</span>}
        />
      );
      expect(screen.getByTestId('left-ad')).toBeInTheDocument();
      expect(screen.getByTestId('right-ad')).toBeInTheDocument();
    });

    it('supports ref forwarding', () => {
      const ref = createRef<HTMLInputElement>();
      render(<Input ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });
  });

  // ==========================================
  // Select Component Tests
  // ==========================================
  describe('Select Component', () => {
    const mockOptions = [
      { value: 'usd', label: 'US Dollar' },
      { value: 'eur', label: 'Euro' },
    ];

    it('renders options correctly', () => {
      render(<Select label="Currency" options={mockOptions} />);
      expect(screen.getByLabelText('Currency')).toBeInTheDocument();
      expect(screen.getAllByRole('option')).toHaveLength(2);
      expect(screen.getByRole('option', { name: 'US Dollar' })).toBeInTheDocument();
    });

    it('displays error and helper text', () => {
      const { rerender } = render(<Select label="Currency" error="Select currency" />);
      expect(screen.getByTestId('select-error')).toHaveTextContent('Select currency');

      rerender(<Select label="Currency" helperText="Base currency" />);
      expect(screen.getByTestId('select-helper')).toHaveTextContent('Base currency');
    });

    it('handles select changes', () => {
      const handleChange = jest.fn();
      render(<Select options={mockOptions} onChange={handleChange} />);
      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: 'eur' } });
      expect(handleChange).toHaveBeenCalledTimes(1);
      expect(select).toHaveValue('eur');
    });
  });

  // ==========================================
  // Modal Component Tests
  // ==========================================
  describe('Modal Component', () => {
    it('does not render when isOpen is false', () => {
      render(
        <Modal isOpen={false} onClose={jest.fn()}>
          <div>Content</div>
        </Modal>
      );
      expect(screen.queryByText('Content')).not.toBeInTheDocument();
    });

    it('renders inside portal when isOpen is true', () => {
      render(
        <Modal isOpen={true} onClose={jest.fn()} ariaLabelledBy="m-title">
          <ModalHeader>
            <ModalTitle id="m-title">Title</ModalTitle>
          </ModalHeader>
          <ModalBody>Content</ModalBody>
          <ModalFooter>Footer</ModalFooter>
        </Modal>
      );
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('calls onClose when overlay clicked', () => {
      const handleClose = jest.fn();
      render(
        <Modal isOpen={true} onClose={handleClose}>
          <div>Modal</div>
        </Modal>
      );
      fireEvent.click(screen.getByTestId('modal-overlay'));
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when container clicked', () => {
      const handleClose = jest.fn();
      render(
        <Modal isOpen={true} onClose={handleClose}>
          <div>Modal</div>
        </Modal>
      );
      fireEvent.click(screen.getByTestId('modal-container'));
      expect(handleClose).not.toHaveBeenCalled();
    });

    it('closes on Escape keypress', () => {
      const handleClose = jest.fn();
      render(
        <Modal isOpen={true} onClose={handleClose}>
          <div>Modal</div>
        </Modal>
      );
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // Card Component Tests
  // ==========================================
  describe('Card Component', () => {
    it('renders card subcomponents', () => {
      render(
        <Card hoverable>
          <CardHeader>
            <CardTitle>Title</CardTitle>
            <CardDescription>Description</CardDescription>
          </CardHeader>
          <CardContent>Content</CardContent>
          <CardFooter>Footer</CardFooter>
        </Card>
      );
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Description')).toBeInTheDocument();
      expect(screen.getByText('Content')).toBeInTheDocument();
      expect(screen.getByText('Footer')).toBeInTheDocument();
    });
  });

  // ==========================================
  // Avatar Component Tests
  // ==========================================
  describe('Avatar Component', () => {
    it('renders fallback initials if no src', () => {
      render(<Avatar name="John Doe" />);
      expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('JD');
    });

    it('handles image load and errors', () => {
      render(<Avatar src="test.jpg" name="John Doe" />);
      // Image starts loading, showing skeleton
      expect(screen.getByTestId('avatar-skeleton')).toBeInTheDocument();

      const image = screen.getByRole('img');
      expect(image).toBeInTheDocument();

      // Simulate load
      fireEvent.load(image);
      expect(screen.queryByTestId('avatar-skeleton')).not.toBeInTheDocument();

      // Simulate error
      fireEvent.error(image);
      expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('JD');
    });
  });
});
