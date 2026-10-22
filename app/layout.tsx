import type { Metadata } from 'next';
import './globals.css';
import { DemoNav } from '@/components/demo-nav';

export const metadata: Metadata = {
  title: 'Data Source Explorer',
  description: 'A unified client and server data source API with controlled Grid examples.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <main>
          <DemoNav />
          {children}
        </main>
      </body>
    </html>
  );
}
