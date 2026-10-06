import { LiveTheater } from '../../components/live-theater';

export default async function LivePage({ searchParams }: { searchParams: Promise<{ mode?: string; run?: string }> }) {
  const { mode, run } = await searchParams;
  return <LiveTheater initialMode={mode === 'replay' ? 'replay' : 'live'} initialRun={run ?? null} />;
}
