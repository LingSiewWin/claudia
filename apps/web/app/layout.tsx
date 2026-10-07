import type { Metadata } from 'next';
import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const grotesk = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-grotesk' });
const code = JetBrains_Mono({ subsets: ['latin'], variable: '--font-code' });
const serif = Newsreader({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-news' });

export const metadata: Metadata = {
  title: { default: 'Claudia', template: '%s · Claudia' },
  description: 'Claudia, the human authority layer for AI agents. Agents are infinite. Human attention is not. Interrupting a person costs a bond; only that person\'s signature moves funds.',
  openGraph: { title: 'Claudia', siteName: 'Claudia', description: 'The human authority layer for AI agents. Interrupting a person costs a bond; only that person\'s signature moves funds.' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${code.variable} ${serif.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
