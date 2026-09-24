import path from 'node:path';
import fg from 'fast-glob';
import YAML from 'yaml';
import { z } from 'zod';
import { assetsDir, sboxDir, exists, readText } from './paths.js';
import type { Change, Phase } from './change.js';
import type { Config } from './config.js';

const artifactSchema = z.object({
  id: z.string(),
  phase: z.string(),
  generates: z.string(),
  template: z.string().optional(),
  requires: z.array(z.string()).default([]),
  optional: z.boolean().default(false),
  /** Пропускается, когда у изменения skip_specs: true. */
  skippable: z.boolean().default(false),
  description: z.string().default(''),
  instruction: z.string().default(''),
});

export const workflowSchema = z.object({
  name: z.string(),
  version: z.number().default(1),
  artifacts: z.array(artifactSchema),
  apply: z.object({ requires: z.array(z.string()).default([]), tracks: z.string().default('tasks.md'), instruction: z.string().default('') }).prefault({}),
});

export type Workflow = z.infer<typeof workflowSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactStatus = 'done' | 'ready' | 'blocked' | 'skipped';

/** Схема артефактов: встроенная assets/schema/default.yaml или проектная .sbox/schema/default.yaml. */
export function loadWorkflow(root: string): Workflow {
  const override = path.join(sboxDir(root), 'schema', 'default.yaml');
  const builtin = path.join(assetsDir(), 'schema', 'default.yaml');
  const file = exists(override) ? override : builtin;
  return workflowSchema.parse(YAML.parse(readText(file)));
}

export function loadTemplate(root: string, name: string): string | null {
  const override = path.join(sboxDir(root), 'schema', 'templates', name);
  const builtin = path.join(assetsDir(), 'templates', name);
  if (exists(override)) return readText(override);
  if (exists(builtin)) return readText(builtin);
  return null;
}

export interface ArtifactState {
  id: string;
  phase: string;
  status: ArtifactStatus;
  optional: boolean;
  outputPath: string;
  existing: string[];
  requires: string[];
}

export function artifactFiles(changeDir: string, artifact: Artifact): string[] {
  if (fg.isDynamicPattern(artifact.generates)) {
    return fg.sync(artifact.generates, { cwd: changeDir, onlyFiles: true }).sort().map((f) => path.join(changeDir, f));
  }
  const file = path.join(changeDir, artifact.generates);
  return exists(file) ? [file] : [];
}

export function artifactStates(workflow: Workflow, change: Change, changeDir: string): ArtifactState[] {
  const states = new Map<string, ArtifactState>();
  for (const artifact of workflow.artifacts) {
    const existing = artifactFiles(changeDir, artifact);
    let status: ArtifactStatus;
    if (artifact.skippable && change.skip_specs) status = 'skipped';
    else if (existing.length > 0) status = 'done';
    else {
      const deps = artifact.requires.map((r) => states.get(r)?.status);
      status = deps.every((s) => s === 'done' || s === 'skipped') ? 'ready' : 'blocked';
    }
    states.set(artifact.id, {
      id: artifact.id,
      phase: artifact.phase,
      status,
      optional: artifact.optional,
      outputPath: path.join(changeDir, artifact.generates),
      existing,
      requires: artifact.requires,
    });
  }
  return [...states.values()];
}

/** Артефакты фазы, которые ещё не сделаны и не пропущены. */
export function pendingArtifacts(states: ArtifactState[], phase: Phase): ArtifactState[] {
  return states.filter((s) => s.phase === phase && s.status !== 'done' && s.status !== 'skipped');
}

export function findArtifact(workflow: Workflow, id: string): Artifact | undefined {
  return workflow.artifacts.find((a) => a.id === id);
}

export interface ArtifactInstructions {
  artifact: string;
  phase: string;
  status: ArtifactStatus;
  description: string;
  instruction: string;
  template: string | null;
  resolvedOutputPath: string;
  existingOutputPaths: string[];
  dependencies: Record<string, string[]>;
  context: string | null;
  rules: string[];
}

export function artifactInstructions(
  root: string,
  config: Config,
  workflow: Workflow,
  change: Change,
  changeDir: string,
  id: string,
  extraInstruction?: string,
): ArtifactInstructions | null {
  const artifact = findArtifact(workflow, id);
  if (!artifact) return null;
  const states = artifactStates(workflow, change, changeDir);
  const state = states.find((s) => s.id === id)!;
  const dependencies: Record<string, string[]> = {};
  for (const dep of artifact.requires) {
    dependencies[dep] = states.find((s) => s.id === dep)?.existing ?? [];
  }
  const instruction = extraInstruction ? `${artifact.instruction.trimEnd()}\n\n${extraInstruction}` : artifact.instruction;
  return {
    artifact: id,
    phase: artifact.phase,
    status: state.status,
    description: artifact.description,
    instruction,
    template: artifact.template ? loadTemplate(root, artifact.template) : null,
    resolvedOutputPath: state.outputPath,
    existingOutputPaths: state.existing,
    dependencies,
    context: config.context ?? null,
    rules: config.rules[id] ?? [],
  };
}
