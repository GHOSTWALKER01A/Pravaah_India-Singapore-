import { redirect } from 'next/navigation';

import { ROUTES } from '@/features/routes';

export default function Home() {
  redirect(ROUTES.DASHBOARD.ROOT);
}
