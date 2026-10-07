import { SiteFooter, SiteHeader } from '../../../components/site-nav';
import { MandateView } from '../../../components/mandate-view';

export default async function MandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell py-8">
      <SiteHeader />
      <div className="mt-10">
        <MandateView key={id} id={decodeURIComponent(id)} />
      </div>
      <SiteFooter />
    </main>
  );
}
