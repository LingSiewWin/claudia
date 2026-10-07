import type { Metadata } from 'next';
import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import { PUBLIC_SITE_URL } from '../lib/config';
import './globals.css';

const grotesk = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-grotesk' });
const code = JetBrains_Mono({ subsets: ['latin'], variable: '--font-code' });
const serif = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-news' });

const description =
  'Give your agents an allowance, not your keys. Every agent gets its own ID and wallet. A mandate sets the daily cap and spending limit. Above the limit it pays a bond to ask you, and only your signature moves the money.';

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: { default: 'Claudia', template: '%s · Claudia' },
  description,
  openGraph: { title: 'Claudia', siteName: 'Claudia', description, type: 'website', url: '/', images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Claudia. Give your agents an allowance, not your keys.' }] },
  twitter: { card: 'summary_large_image', title: 'Claudia', description, images: ['/og.png'] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${code.variable} ${serif.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
