import { networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';

export interface ReachableAddress {
  label: string;
  url: string;
}

const TAILSCALE_CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

interface TailscaleServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * Inspect `tailscale serve status --json` for any Web proxies pointing at our
 * local port. Returns one ReachableAddress per matching proxy (could be HTTP
 * and HTTPS both, if the operator has opted into both). Returns empty when
 * Tailscale isn't installed, no serve config exists, or none match our port.
 */
function detectTailscaleServe(port: number): ReachableAddress[] {
  try {
    const raw = execSync('tailscale serve status --json', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (!raw) return [];
    const config: TailscaleServeConfig = JSON.parse(raw);
    const targets = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const out: ReachableAddress[] = [];
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      for (const handler of Object.values(web.Handlers ?? {})) {
        if (!handler.Proxy || !targets.includes(handler.Proxy)) continue;
        const [host, p] = hostPort.split(':');
        if (!host || !p) continue;
        const tcp = (config.TCP ?? {})[p];
        const isHttps = Boolean(tcp?.HTTPS);
        const proto = isHttps ? 'https' : 'http';
        const defaultPort = isHttps ? '443' : '80';
        const portSuffix = p === defaultPort ? '' : `:${p}`;
        out.push({
          label: isHttps ? 'Tailscale HTTPS' : 'Tailscale HTTP',
          url: `${proto}://${host}${portSuffix}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Build the address list shown on `llmuxd serve` startup. */
export function getAddresses(port: number): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const tailscaleServe = detectTailscaleServe(port);
  // HTTPS-first ordering: the friendliest URL for browsers comes first.
  for (const a of tailscaleServe.sort((a, b) => (a.label === 'Tailscale HTTPS' ? -1 : 1))) {
    out.push(a);
  }
  out.push({ label: 'Local', url: `http://localhost:${port}` });
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
