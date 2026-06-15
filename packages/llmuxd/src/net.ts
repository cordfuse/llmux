import { networkInterfaces } from 'node:os';

export interface ReachableAddress {
  label: 'Local' | 'LAN' | 'Tailscale';
  url: string;
}

const TAILSCALE_CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Build the address list shown on `llmuxd serve` startup. */
export function getAddresses(port: number): ReachableAddress[] {
  const out: ReachableAddress[] = [{ label: 'Local', url: `http://localhost:${port}` }];
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const isTailscale = TAILSCALE_CGNAT.test(iface.address);
      out.push({
        label: isTailscale ? 'Tailscale' : 'LAN',
        url: `http://${iface.address}:${port}`,
      });
    }
  }
  return out;
}
