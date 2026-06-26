// workflow.ts — runtime workflow executor.
//
// A workflow marker is a `type: workflow` message addressed to the reserved
// recipient `workflow`. The runtime processes it directly: no model wakes
// for it via the activation loop. The persona-orchestrator pattern from
// pre-alpha v7 is gone — workflows are now compile-pass + deterministic
// runtime execution, so every supported agent CLI works regardless of
// model's instruction-following discipline.
//
// One phase advances per dispatcher tick. State is derived from files
// each tick — no in-memory workflow registry, no recovery logic needed
// across dispatcher restarts.
//
//   1. compile     — invoke the first claimed model with COMPILE_PROMPT
//                    and the workflow body. Parse JSON plan. Save to
//                    data/channels/<child>/PLAN.json, or fail the workflow.
//   2. fanout      — write `plan.fanout.count` sub-primitives into the
//                    child channel addressed to `plan.fanout.to`.
//   3. synthesize  — once all fanout replies are in, write one synthesis
//                    sub-primitive into the child channel with body =
//                    plan.synthesize.body + the concatenated reply bodies.
//   4. route       — once the synthesis reply lands, write a final reply
//                    in the PARENT channel addressed to the workflow
//                    marker's `from:`, re:-linked to the marker. Drop a
//                    COMPLETE side file so future ticks skip this marker.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { now, messageFilename } from './filenames.ts';
import { serializeFrontmatter } from './frontmatter.ts';
import { invokeModelCli } from './invoke.ts';
import { listChannelMessages, type ChannelMessage } from './transport.ts';
import { logError } from './state.ts';
import { dispatchersForModel } from './dispatchers.ts';
import type { ModelEntry, ModelsRegistry } from './models.ts';
import { resolveModelRef, formatResolutionError } from './resolve.ts';

export const WORKFLOW_RECIPIENT = 'workflow';

export interface WorkflowPlan {
  fanout: { to: string; count: number; body: string };
  synthesize: { to: string; body: string };
}

export const COMPILE_PROMPT = [
  'Compile the workflow markdown document below into a single JSON object',
  'with this exact shape:',
  '',
  '{"fanout":{"to":"<provider>/<model>","count":<integer 1-10>,"body":"<task>"},',
  ' "synthesize":{"to":"<provider>/<model>","body":"<instruction>"}}',
  '',
  'Field meaning:',
  '  fanout.to        the model identity in qualified `<provider>/<model>` form',
  '                   (from data/crosstalk.yaml). A bare `<model>` is accepted',
  '                   but resolved as ambiguous when multiple providers offer',
  '                   it; prefer the qualified form for stability.',
  '  fanout.count     how many parallel workers, integer 1-10',
  '  fanout.body      the task each fanout worker performs',
  '  synthesize.to    the model identity that picks/merges the fanout replies',
  '                   (same `<provider>/<model>` form)',
  '  synthesize.body  the instruction the synthesizer follows',
  '',
  'Output ONLY the JSON object. No prose, no markdown fences, no explanation.',
  'The workflow document follows:',
  '',
].join('\n');

function channelDir(transportRoot: string, channelUuid: string): string {
  return join(transportRoot, 'data', 'channels', channelUuid);
}

function planPath(transportRoot: string, childUuid: string): string {
  return join(channelDir(transportRoot, childUuid), 'PLAN.json');
}

function completePath(transportRoot: string, childUuid: string): string {
  return join(channelDir(transportRoot, childUuid), 'COMPLETE');
}

export function validatePlan(p: unknown): p is WorkflowPlan {
  if (typeof p !== 'object' || p == null) return false;
  const x = p as Record<string, unknown>;
  const f = x['fanout'] as Record<string, unknown> | undefined;
  const s = x['synthesize'] as Record<string, unknown> | undefined;
  if (!f || !s) return false;
  if (typeof f['to'] !== 'string' || f['to'].length === 0) return false;
  const c = f['count'];
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 10) return false;
  if (typeof f['body'] !== 'string') return false;
  if (typeof s['to'] !== 'string' || s['to'].length === 0) return false;
  if (typeof s['body'] !== 'string') return false;
  return true;
}

function loadPlan(transportRoot: string, childUuid: string): WorkflowPlan | null {
  const p = planPath(transportRoot, childUuid);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    return validatePlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Models occasionally wrap JSON in markdown fences or add a sentence before
// the object despite the prompt's "JSON only" instruction. Extract the first
// balanced {...} block as a fallback.
export function extractPlanFromOutput(stdout: string): WorkflowPlan | null {
  const trimmed = stdout.trim();
  const tryParse = (s: string): WorkflowPlan | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      return validatePlan(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return tryParse(trimmed.slice(start, end + 1));
}

export interface WorkflowMarker {
  parentChannelUuid: string;
  childChannelUuid: string;
  markerRelPath: string;
  markerFrom: string;
  body: string;
  // When set, only the dispatcher whose alias matches progresses this
  // workflow's phases. Markers without dispatch_host fall back to
  // race-based progression (acceptable for single-host transports).
  dispatchHost?: string | undefined;
}

export function findOpenWorkflows(
  transportRoot: string,
  channels: string[],
  alias?: string,
): WorkflowMarker[] {
  const out: WorkflowMarker[] = [];
  for (const parentUuid of channels) {
    const messages = listChannelMessages(transportRoot, parentUuid);
    for (const m of messages) {
      if (m.data['type'] !== 'workflow') continue;
      const childUuid = m.data['child_channel'];
      if (typeof childUuid !== 'string') continue;
      if (existsSync(completePath(transportRoot, childUuid))) continue;
      const dispatchHost = typeof m.data['dispatch_host'] === 'string'
        ? (m.data['dispatch_host'] as string)
        : undefined;
      // Ownership filter: when the marker pins a dispatch_host, only that
      // dispatcher progresses it. Other dispatchers see the marker (it's a
      // normal message) but skip it here, leaving the workflow's runtime
      // work to its owner.
      if (dispatchHost && alias && dispatchHost !== alias) continue;
      const from = typeof m.data['from'] === 'string' ? (m.data['from'] as string) : 'unknown';
      out.push({
        parentChannelUuid: parentUuid,
        childChannelUuid: childUuid,
        markerRelPath: m.relPath,
        markerFrom: from,
        body: m.body,
        dispatchHost,
      });
    }
  }
  return out;
}

function senderOf(msg: ChannelMessage): string {
  return typeof msg.data['from'] === 'string' ? (msg.data['from'] as string) : 'unknown';
}

function workflowDispatches(
  transportRoot: string,
  childUuid: string,
  alias: string,
  phase: 'fanout' | 'synthesize',
): ChannelMessage[] {
  const fromName = `workflow@${alias}`;
  return listChannelMessages(transportRoot, childUuid).filter(
    (m) => senderOf(m) === fromName && m.data['workflow_phase'] === phase,
  );
}

function repliesTo(
  transportRoot: string,
  childUuid: string,
  targetRelPaths: string[],
): ChannelMessage[] {
  const targetSet = new Set(targetRelPaths);
  return listChannelMessages(transportRoot, childUuid).filter((m) => {
    const re = m.data['re'];
    if (typeof re === 'string') return targetSet.has(re);
    if (Array.isArray(re)) return re.some((r) => typeof r === 'string' && targetSet.has(r));
    return false;
  });
}

interface WriteOpts {
  transportRoot: string;
  channelUuid: string;
  from: string;
  to: string;
  body: string;
  workflowPhase?: 'fanout' | 'synthesize' | undefined;
  re?: string | undefined;
  failed?: { error: string } | undefined;
}

function writeRuntimeMessage(opts: WriteOpts): string {
  const ts = now();
  const dir = join(channelDir(opts.transportRoot, opts.channelUuid), ts.pathDate);
  mkdirSync(dir, { recursive: true });
  const fm: Record<string, unknown> = {
    from: opts.from,
    to: opts.to,
    timestamp: ts.iso,
  };
  if (opts.re) fm['re'] = opts.re;
  if (opts.workflowPhase) fm['workflow_phase'] = opts.workflowPhase;
  if (opts.failed) {
    fm['failed'] = true;
    fm['error'] = opts.failed.error.slice(0, 2000);
  }
  const filename = messageFilename(ts);
  writeFileSync(join(dir, filename), serializeFrontmatter(fm, opts.body));
  return join(ts.pathDate, filename);
}

function markComplete(transportRoot: string, childUuid: string): void {
  writeFileSync(completePath(transportRoot, childUuid), new Date().toISOString() + '\n');
}

function failWorkflow(
  transportRoot: string,
  marker: WorkflowMarker,
  alias: string,
  error: string,
): void {
  writeRuntimeMessage({
    transportRoot,
    channelUuid: marker.parentChannelUuid,
    from: `workflow@${alias}`,
    to: marker.markerFrom,
    body: error,
    re: marker.markerRelPath,
    failed: { error },
  });
  markComplete(transportRoot, marker.childChannelUuid);
}

export interface WorkflowTickContext {
  transportRoot: string;
  alias: string;
  registry: ModelsRegistry;     // full registry (all + byBareName + claimed)
  claimed: Map<string, ModelEntry>;  // shorthand for registry.claimed
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export async function workflowTick(
  ctx: WorkflowTickContext,
  channels: string[],
): Promise<boolean> {
  const open = findOpenWorkflows(ctx.transportRoot, channels, ctx.alias);
  if (open.length === 0) return false;
  let progressed = false;
  for (const marker of open) {
    try {
      const did = await advanceOne(ctx, marker);
      if (did) progressed = true;
    } catch (err) {
      const msg = (err as Error).message;
      logError(ctx.transportRoot, `workflow ${marker.markerRelPath} crashed: ${msg}`);
      ctx.log('workflow_crash', { marker: marker.markerRelPath, error: msg.slice(0, 200) });
      failWorkflow(ctx.transportRoot, marker, ctx.alias, `runtime error: ${msg.slice(0, 500)}`);
      progressed = true;
    }
  }
  return progressed;
}

async function advanceOne(ctx: WorkflowTickContext, marker: WorkflowMarker): Promise<boolean> {
  const { transportRoot, alias, claimed } = ctx;
  const fromIdentity = `workflow@${alias}`;

  // Phase 1: compile.
  let plan = loadPlan(transportRoot, marker.childChannelUuid);
  if (!plan) {
    const firstClaimed = claimed.values().next().value as ModelEntry | undefined;
    if (!firstClaimed) {
      failWorkflow(transportRoot, marker, alias, 'no claimed model available to compile the workflow');
      ctx.log('workflow_compile_no_model', { marker: marker.markerRelPath });
      return true;
    }
    ctx.log('workflow_compile_start', {
      marker: marker.markerRelPath,
      compile_model: firstClaimed.name,
    });
    const result = await invokeModelCli(firstClaimed, COMPILE_PROMPT, marker.body, {});
    if (result.status !== 0) {
      failWorkflow(transportRoot, marker, alias,
        `compile model exit=${result.status}: ${result.stderr.slice(0, 500)}`);
      ctx.log('workflow_compile_failed', { marker: marker.markerRelPath, exit: result.status });
      return true;
    }
    const parsed = extractPlanFromOutput(result.stdout);
    if (!parsed) {
      failWorkflow(transportRoot, marker, alias,
        `could not parse workflow prose. Compiler returned:\n${result.stdout.slice(0, 800)}`);
      ctx.log('workflow_compile_invalid', { marker: marker.markerRelPath });
      return true;
    }
    // Resolve fanout + synthesize targets via the addressing layer.
    // Compile model may emit bare names; resolver normalizes to qualified
    // (single unambiguous match) or fails the workflow with a pick-list.
    const fanoutRes = resolveModelRef(parsed.fanout.to, ctx.registry);
    if (fanoutRes.kind !== 'ok') {
      failWorkflow(transportRoot, marker, alias,
        `compiled plan fanout: ${formatResolutionError(fanoutRes)}`);
      return true;
    }
    const synthRes = resolveModelRef(parsed.synthesize.to, ctx.registry);
    if (synthRes.kind !== 'ok') {
      failWorkflow(transportRoot, marker, alias,
        `compiled plan synthesize: ${formatResolutionError(synthRes)}`);
      return true;
    }
    // Normalize plan to qualified form before persisting so every
    // subsequent tick sees the same addressing.
    parsed.fanout.to = fanoutRes.model.qualified;
    parsed.synthesize.to = synthRes.model.qualified;
    writeFileSync(planPath(transportRoot, marker.childChannelUuid), JSON.stringify(parsed, null, 2) + '\n');
    plan = parsed;
    ctx.log('workflow_compiled', {
      marker: marker.markerRelPath,
      fanout: `${plan.fanout.to}x${plan.fanout.count}`,
      synthesize: plan.synthesize.to,
    });
    return true;
  }

  // Phase 2: fanout dispatch.
  //
  // Distribution: read the dispatcher registry to find every dispatcher
  // claiming the fanout model. Round-robin the N sub-primitives across
  // them, scoping each as `to: <model>@<alias>`. Without this, bare
  // `to: <model>` dispatches get claimed by EVERY dispatcher (at-least-
  // once activation), turning a fan-out into N× duplicated work for 1×
  // throughput — defeating the multi-host value prop entirely.
  //
  // Fallback: if the registry is empty (single-host case with no
  // dispatcher publishing, or a transient race between dispatcher start
  // and workflow dispatch), use the bare recipient. Single-host: only
  // one dispatcher claims anyway, so bare is safe. Empty registry on
  // multi-host: degrade to current duplicate-work behavior with a logged
  // warning rather than failing the workflow.
  const fanouts = workflowDispatches(transportRoot, marker.childChannelUuid, alias, 'fanout');
  if (fanouts.length === 0) {
    const candidates = dispatchersForModel(transportRoot, plan.fanout.to);
    const distribution = candidates.length === 0 ? null : candidates;
    if (distribution === null) {
      ctx.log('workflow_fanout_no_registry_fallback', {
        marker: marker.markerRelPath,
        model: plan.fanout.to,
      });
    }
    for (let i = 0; i < plan.fanout.count; i++) {
      const to = distribution === null
        ? plan.fanout.to
        : `${plan.fanout.to}@${distribution[i % distribution.length]}`;
      writeRuntimeMessage({
        transportRoot,
        channelUuid: marker.childChannelUuid,
        from: fromIdentity,
        to,
        body: plan.fanout.body,
        workflowPhase: 'fanout',
      });
    }
    ctx.log('workflow_fanout_dispatched', {
      marker: marker.markerRelPath,
      count: plan.fanout.count,
      to: plan.fanout.to,
      dispatchers: distribution ?? 'bare',
    });
    return true;
  }

  // Phase 3: wait for fanout replies. Failed replies count toward the total
  // so we don't stall on individual worker failures — the synthesizer sees
  // them as FAILED candidates and decides.
  const fanoutRelPaths = fanouts.map((m) => m.relPath);
  const fanoutReplies = repliesTo(transportRoot, marker.childChannelUuid, fanoutRelPaths);
  if (fanoutReplies.length < plan.fanout.count) {
    return false;
  }

  // Phase 4: synthesize dispatch.
  //
  // Pin to one specific dispatcher so we don't duplicate the synthesis
  // (which costs another model call and emits another routed reply).
  // Pick deterministically — first alias in sorted-claim order — so the
  // assignment is reproducible. Falls back to bare on empty registry,
  // accepting the duplication risk (already documented for fanout above).
  const synthesizes = workflowDispatches(transportRoot, marker.childChannelUuid, alias, 'synthesize');
  if (synthesizes.length === 0) {
    const synthCandidates = dispatchersForModel(transportRoot, plan.synthesize.to);
    const synthTo = synthCandidates.length === 0
      ? plan.synthesize.to
      : `${plan.synthesize.to}@${synthCandidates[0]}`;
    const candidatesText = fanoutReplies
      .slice()
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((m, i) => {
        const failed = m.data['failed'] === true ? ' (FAILED)' : '';
        return `--- candidate ${i + 1}${failed} ---\n${m.body}`;
      })
      .join('\n\n');
    const synthBody = `${plan.synthesize.body}\n\n${candidatesText}`;
    writeRuntimeMessage({
      transportRoot,
      channelUuid: marker.childChannelUuid,
      from: fromIdentity,
      to: synthTo,
      body: synthBody,
      workflowPhase: 'synthesize',
    });
    ctx.log('workflow_synthesize_dispatched', {
      marker: marker.markerRelPath,
      to: synthTo,
      candidates: fanoutReplies.length,
    });
    return true;
  }

  // Phase 5: wait for synthesis reply.
  const synthRelPaths = synthesizes.map((m) => m.relPath);
  const synthReplies = repliesTo(transportRoot, marker.childChannelUuid, synthRelPaths);
  if (synthReplies.length === 0) return false;

  // Phase 6: route final reply back to the operator who launched the workflow.
  const finalSource = synthReplies
    .slice()
    .sort((a, b) => a.relPath.localeCompare(b.relPath))[0]!;
  const finalFailed = finalSource.data['failed'] === true;
  writeRuntimeMessage({
    transportRoot,
    channelUuid: marker.parentChannelUuid,
    from: fromIdentity,
    to: marker.markerFrom,
    body: finalSource.body,
    re: marker.markerRelPath,
    failed: finalFailed
      ? { error: typeof finalSource.data['error'] === 'string'
          ? (finalSource.data['error'] as string)
          : 'synthesize failed' }
      : undefined,
  });
  markComplete(transportRoot, marker.childChannelUuid);
  ctx.log('workflow_complete', {
    marker: marker.markerRelPath,
    final_failed: finalFailed,
  });
  return true;
}
