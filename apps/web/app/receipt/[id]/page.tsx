import { SiteFooter, SiteHeader } from '../../../components/site-nav';
import { ReceiptView } from '../../../components/receipt-view';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell py-8">
      <SiteHeader />
      <div className="mt-10">
        <ReceiptView id={decodeURIComponent(id)} />
      </div>
      <SiteFooter />
    </main>
  );
}
