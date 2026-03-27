import type {Metadata} from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Toaster } from 'react-hot-toast';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Etsy Digital PNG Pro | AI T-Shirt Design Upgrader',
  description: 'Reverse-engineer and upgrade t-shirt designs into high-quality Etsy Digital PNG products with optimized SEO.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.className} bg-zinc-950 text-zinc-100 min-h-screen`} suppressHydrationWarning>
        {children}
        <Toaster position="bottom-right" toastOptions={{
          style: {
            background: '#18181b',
            color: '#f4f4f5',
            border: '1px solid #27272a',
          },
        }} />
      </body>
    </html>
  );
}
