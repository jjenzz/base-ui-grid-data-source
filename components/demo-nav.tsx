'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/server', label: 'Server grid' },
  { href: '/client', label: 'Server + client grid' },
  { href: '/lazy', label: 'Server + client lazy grid' },
];

export function DemoNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Grid demos">
      {links.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
