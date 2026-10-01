import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jev Workflow Builder',
  description: 'Describe a Loopfour Studio workflow in plain language; Jev maps it to blocks, actions and fields without an LLM.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
