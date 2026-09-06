import { getIps } from '../../lib/data';
import { Badge, PageHead } from '../../lib/ui';

export default async function IpsPage() {
  const ips = await getIps();

  return (
    <>
      <PageHead
        title="IPS — Investment Policy Statement"
        badge={<Badge tone="gray">v{ips.version} · effective {ips.effectiveAt.slice(0, 10)}</Badge>}
        sub="The policy you are held to. Versioned, never edited in place — a change is a new version."
      />
      <pre className="ips-text">{ips.fullText}</pre>
    </>
  );
}