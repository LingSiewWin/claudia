import { ConsoleView } from '../../components/console-view';
import { config } from '../../lib/config';

export default function ConsolePage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <ConsoleView mandateId={config.stageMandateId} />
    </main>
  );
}
