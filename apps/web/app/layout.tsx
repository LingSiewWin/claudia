import type { Metadata } from 'next';
import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const grotesk = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-grotesk' });
const code = JetBrains_Mono({ subsets: ['latin'], variable: '--font-code' });
const serif = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-news' });

export const metadata: Metadata = {
  title: { default: 'Claudia', template: '%s · Claudia' },
  description: 'Give your agents an allowance, not your keys. Every agent gets its own ID and wallet. A mandate sets the daily cap and spending limit. Above the limit it pays a bond to ask you, and only your signature moves the money.',
  openGraph: { title: 'Claudia', siteName: 'Claudia', description: 'Give your agents an allowance, not your keys. Every agent gets its own ID and wallet. A mandate sets the daily cap and spending limit. Above the limit it pays a bond to ask you, and only your signature moves the money.' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${code.variable} ${serif.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
