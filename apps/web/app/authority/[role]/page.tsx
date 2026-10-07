import { SiteFooter, SiteHeader } from '../../../components/site-nav';
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
    <main className="shell py-8">
      <SiteHeader />
      <div className="mt-10">
        <AuthorityView key={`${role}:${mandateId}`} role={decodeURIComponent(role)} mandateId={mandateId} />
      </div>
      <SiteFooter />
    </main>
  );
}
