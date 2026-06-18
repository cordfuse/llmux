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

interface ServeMatch {
  hostname: string;
  hasHttp: boolean;
  hasHttps: boolean;
  httpPort?: string;
  httpsPort?: string;
}

/**
 * Returns the tailnet hostname + which schemes have a `tailscale serve` config
 * that proxies to our local port. Empty when tailscale isn't installed or no
 * serve config matches.
 */
function detectTailscaleServe(port: number): ServeMatch | undefined {
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
    let hostname: string | undefined;
    let hasHttp = false;
    let hasHttps = false;
    let httpPort: string | undefined;
    let httpsPort: string | undefined;
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      for (const handler of Object.values(web.Handlers ?? {})) {
        if (!handler.Proxy || !targets.includes(handler.Proxy)) continue;
        const [host, p] = hostPort.split(':');
        if (!host || !p) continue;
        hostname = host;
        const tcp = (config.TCP ?? {})[p];
        if (tcp?.HTTPS) {
          hasHttps = true;
          httpsPort = p;
        } else if (tcp?.HTTP) {
          hasHttp = true;
          httpPort = p;
        }
      }
    }
    if (!hostname) return undefined;
    return { hostname, hasHttp, hasHttps, ...(httpPort ? { httpPort } : {}), ...(httpsPort ? { httpsPort } : {}) };
  } catch {
    return undefined;
  }
}

function findTailscaleIp(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (TAILSCALE_CGNAT.test(iface.address)) return iface.address;
    }
  }
  return undefined;
}

/** Build the address list shown on `llmux server start` startup. */
export function getAddresses(port: number): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const serve = detectTailscaleServe(port);
  const tailscaleIp = findTailscaleIp();

  // Tailscale HTTPS — only exists if `tailscale serve --https` is configured.
  if (serve?.hasHttps) {
    const portSuffix = serve.httpsPort && serve.httpsPort !== '443' ? `:${serve.httpsPort}` : '';
    out.push({ label: 'Tailscale HTTPS', url: `https://${serve.hostname}${portSuffix}` });
  }

  // Tailscale HTTP — one entry whenever tailscale is up. Prefer the friendlier
  // hostname-via-serve form when `tailscale serve --http` is configured; fall
  // back to the direct IP+port form. Same conceptual slot either way.
  if (serve?.hasHttp) {
    const portSuffix = serve.httpPort && serve.httpPort !== '80' ? `:${serve.httpPort}` : '';
    out.push({ label: 'Tailscale HTTP', url: `http://${serve.hostname}${portSuffix}` });
  } else if (tailscaleIp) {
    out.push({ label: 'Tailscale HTTP', url: `http://${tailscaleIp}:${port}` });
  }

  // Local
  out.push({ label: 'Local', url: `http://localhost:${port}` });

  // LAN — every non-internal, non-tailnet IPv4 interface
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (TAILSCALE_CGNAT.test(iface.address)) continue;
      out.push({ label: 'LAN', url: `http://${iface.address}:${port}` });
    }
  }

  return out;
}
