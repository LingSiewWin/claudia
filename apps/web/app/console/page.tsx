import { SiteFooter, SiteHeader } from '../../components/site-nav';
import { ConsoleView } from '../../components/console-view';
import { config } from '../../lib/config';

export default function ConsolePage() {
  return (
    <main className="shell py-8">
      <SiteHeader />
      <div className="mt-10">
        <ConsoleView mandateId={config.stageMandateId} />
      </div>
      <SiteFooter />
    </main>
  );
}
