import '@testing-library/jest-dom';

import { render, screen } from '@testing-library/react';

import Home from '../src/app/page';
import { Button } from '../src/components/ui/button';

describe('Frontend Smoke Tests', () => {
  it('renders home page title', () => {
    render(<Home />);
    const heading = screen.getByText('AfriDollar');
    expect(heading).toBeInTheDocument();
  });

  it('renders home page descriptions', () => {
    render(<Home />);
    const text = screen.getByText(/Stellar-powered financial infrastructure/i);
    expect(text).toBeInTheDocument();
  });

  it('renders primary button', () => {
    render(<Button variant="primary">Click me</Button>);
    const button = screen.getByRole('button', { name: /click me/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('bg-primary-600');
  });

  it('renders outline button', () => {
    render(<Button variant="outline">Outline</Button>);
    const button = screen.getByRole('button', { name: /outline/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('border');
  });
});
