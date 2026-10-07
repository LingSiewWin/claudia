import { AuthorityView } from '../../../components/authority-view';
import { config } from '../../../lib/config';

export default async function AuthorityPage({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>;
  searchParams: Promise<{ mandate_id?: string }>;
}) {
  const { role } = await params;
  const { mandate_id } = await searchParams;
  const mandateId = mandate_id ?? config.stageMandateId;
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <AuthorityView key={`${role}:${mandateId}`} role={decodeURIComponent(role)} mandateId={mandateId} />
    </main>
  );
}
