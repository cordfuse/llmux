// Cherry-picked from cordfuse/crosstalk@v7.0.0-alpha.16 (engine/src/filenames.ts).
// Unmodified — preserves wire-compatibility with crosstalk transport format.

import { randomBytes } from 'crypto';

export interface Timestamp {
  iso: string;
  pathDate: string;
  fileTime: string;
  hex: string;
}

export function now(): Timestamp {
  const d = new Date();
  const iso = d.toISOString();
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const dd = iso.slice(8, 10);
  const time = iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19);
  const ms = iso.slice(20, 23);
  return {
    iso,
    pathDate: `${yyyy}/${mm}/${dd}`,
    fileTime: `${time}${ms}Z`,
    hex: randomBytes(4).toString('hex'),
  };
}

export function messageFilename(ts: Timestamp = now()): string {
  return `${ts.fileTime}-${ts.hex}.md`;
}
