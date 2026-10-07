import { MandateView } from '../../../components/mandate-view';

export default async function MandatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <MandateView key={id} id={decodeURIComponent(id)} />
    </main>
  );
}
