import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'ARF-OS',
  description: 'AI Research Hedge Fund Operating System',
};

const NAV = [
  { href: '/', label: 'Command Centre' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/strategies', label: 'Strategy Library' },
  { href: '/markets', label: 'Markets' },
  { href: '/committee', label: 'Committee' },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">ARF-OS</span>
          <span className="env-badge" data-env={process.env.NODE_ENV}>
            {process.env.NODE_ENV}
          </span>
        </header>
        <div className="shell">
          <nav aria-label="Primary">
            <ul>
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <main>{children}</main>
        </div>
        <footer className="disclaimer">
          {/* Section 18: no claim of future profitability, anywhere. */}
          Historical and simulated results only. Past performance does not indicate future results.
        </footer>
      </body>
    </html>
  );
}
