// Workflow summary helpers — reconstruct workflow state from messages on disk.
// Ported from crosstalk/src/api.ts (collectWorkflowSummaries + readChannelMeta).
// Skips the detail view (collectWorkflowDetail) for the v1 port.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { discoverChannels, listChannelMessages, type ChannelMessage } from './transport.ts';
import { parseFrontmatter } from './frontmatter.ts';

export interface ChannelMeta {
  uuid: string;
  name: string | null;
  parent: string | null;
}

export interface WorkflowSummary {
  childChannelUuid: string;
  parentChannelUuid: string;
  parentChannelName: string | null;
  markerFrom: string;
  markerTimestamp: string;
  phase: 'pending_compile' | 'fanout' | 'synthesize' | 'complete' | 'failed';
  fanoutTotal: number;
  fanoutReplied: number;
  dispatchHost: string | null;
}

export function readChannelMeta(transportRoot: string, uuid: string): ChannelMeta {
  const chPath = join(transportRoot, 'data', 'channels', uuid, 'CHANNEL.md');
  if (!existsSync(chPath)) return { uuid, name: null, parent: null };
  const raw = readFileSync(chPath, 'utf-8');
  const { data } = parseFrontmatter<{ name?: unknown; parent?: unknown }>(raw);
  return {
    uuid,
    name: typeof data.name === 'string' ? data.name : null,
    parent: typeof data.parent === 'string' ? data.parent : null,
  };
}

export function collectWorkflowSummaries(transportRoot: string): WorkflowSummary[] {
  const channels = discoverChannels(transportRoot);
  const out: WorkflowSummary[] = [];
  for (const parentUuid of channels) {
    const parentMeta = readChannelMeta(transportRoot, parentUuid);
    const parentMessages = listChannelMessages(transportRoot, parentUuid);
    for (const m of parentMessages) {
      if (m.data['type'] !== 'workflow') continue;
      const childUuid = m.data['child_channel'];
      if (typeof childUuid !== 'string') continue;
      out.push(buildSummary(transportRoot, parentMeta, childUuid, m));
    }
  }
  out.sort((a, b) => (b.markerTimestamp || '').localeCompare(a.markerTimestamp || ''));
  return out;
}

function buildSummary(
  transportRoot: string,
  parentMeta: ChannelMeta,
  childUuid: string,
  marker: ChannelMessage,
): WorkflowSummary {
  const completeFile = join(transportRoot, 'data', 'channels', childUuid, 'COMPLETE');
  const planFile = join(transportRoot, 'data', 'channels', childUuid, 'PLAN.json');
  const isComplete = existsSync(completeFile);
  const childMessages = existsSync(join(transportRoot, 'data', 'channels', childUuid))
    ? listChannelMessages(transportRoot, childUuid)
    : [];

  const fanoutDispatches = childMessages.filter((m) => m.data['workflow_phase'] === 'fanout');
  const fanoutDispatchPaths = new Set(fanoutDispatches.map((m) => m.relPath));
  const fanoutReplies = childMessages.filter((m) => {
    const re = m.data['re'];
    const list = Array.isArray(re) ? re : (typeof re === 'string' ? [re] : []);
    return list.some((p) => fanoutDispatchPaths.has(p));
  });

  const anyFailedReply = childMessages.some((m) => m.data['failed'] === true);

  let phase: WorkflowSummary['phase'];
  if (isComplete) phase = 'complete';
  else if (anyFailedReply) phase = 'failed';
  else if (!existsSync(planFile)) phase = 'pending_compile';
  else {
    const synth = childMessages.find((m) => m.data['workflow_phase'] === 'synthesize');
    phase = synth ? 'synthesize' : 'fanout';
  }

  const dispatchHost = typeof marker.data['dispatch_host'] === 'string'
    ? (marker.data['dispatch_host'] as string)
    : null;

  return {
    childChannelUuid: childUuid,
    parentChannelUuid: parentMeta.uuid,
    parentChannelName: parentMeta.name,
    markerFrom: String(marker.data['from'] ?? 'unknown'),
    markerTimestamp: String(marker.data['timestamp'] ?? ''),
    phase,
    fanoutTotal: fanoutDispatches.length,
    fanoutReplied: fanoutReplies.length,
    dispatchHost,
  };
}
