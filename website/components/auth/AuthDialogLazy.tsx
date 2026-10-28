'use client';

import dynamic from 'next/dynamic';

/** The sign-in dialog is not needed to read a page, so its code is fetched after the page is interactive. */
const AuthDialog = dynamic(() => import('./AuthDialog'), { ssr: false });

export default function AuthDialogLazy() {
  return <AuthDialog />;
}
