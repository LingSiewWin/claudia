import { ReceiptView } from '../../../components/receipt-view';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <ReceiptView id={decodeURIComponent(id)} />
    </main>
  );
}
