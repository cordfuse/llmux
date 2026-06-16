import { networkInterfaces } from 'node:os';
import { execSync } from 'node:child_process';

export interface ReachableAddress {
  label: string;
  url: string;
}

const TAILSCALE_CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

interface TailscaleServeConfig {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * If the operator has run `tailscale serve --https=<port> http://localhost:<our-port>`,
 * Tailscale terminates TLS on the tailnet hostname and proxies to us. Detect that
 * config and surface the HTTPS URL. Returns undefined if Tailscale isn't installed,
 * the user hasn't opted in to HTTPS serve, or the serve config doesn't point at our port.
 */
function detectTailscaleHttps(port: number): string | undefined {
  try {
    const raw = execSync('tailscale serve status --json', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    })
      .toString()
      .trim();
    if (!raw) return undefined;
    const config: TailscaleServeConfig = JSON.parse(raw);
    const targets = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      for (const handler of Object.values(web.Handlers ?? {})) {
        if (handler.Proxy && targets.includes(handler.Proxy)) {
          const [host, p] = hostPort.split(':');
          if (!host) continue;
          const portSuffix = p && p !== '443' ? `:${p}` : '';
          return `https://${host}${portSuffix}`;
        }
      }
    }
  } catch {}
  return undefined;
}

/** Build the address list shown on `llmuxd serve` startup. */
export function getAddresses(port: number): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const httpsUrl = detectTailscaleHttps(port);
  if (httpsUrl) {
    out.push({ label: 'Tailscale HTTPS', url: httpsUrl });
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
