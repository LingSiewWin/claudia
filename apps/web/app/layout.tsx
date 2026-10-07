import type { Metadata } from 'next';
import { JetBrains_Mono, Schibsted_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const grotesk = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-grotesk' });
const code = JetBrains_Mono({ subsets: ['latin'], variable: '--font-code' });

export const metadata: Metadata = {
  title: { default: 'Authority Layer', template: '%s · Authority Layer' },
  description: 'Agents are infinite. Human attention is not. Interrupting a person costs a bond; only that person\'s signature moves funds.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${code.variable}`}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
