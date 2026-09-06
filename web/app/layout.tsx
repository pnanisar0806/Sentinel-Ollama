import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Nav from './nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sentinel — Investment Intelligence',
  description: 'Personal investment intelligence agent — local preview',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}