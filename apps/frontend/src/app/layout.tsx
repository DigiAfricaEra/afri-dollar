import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'AfriDollar - Digital Dollar Infrastructure for African Businesses',
  description: 'Stellar-powered financial infrastructure platform for African businesses',
};

/**
 * RootLayout component wraps all pages in the Next.js application.
 * It provides the global HTML structure and imports global styles.
 */
export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
