import { slugify, type Capability, type Requirement, type Scenario } from '../../../core/spec-model.js';

/**
 * Разбор спецификаций OpenSpec (openspec/specs/<capability-path>/spec.md).
 * Правила совпадают с парсером OpenSpec: `## Requirements` до следующего `## `, блоки `### Requirement:`,
 * сценарии это любые заголовки `#### `, содержимое fenced-блоков кода игнорируется при поиске заголовков.
 */
export const REQUIREMENT_HEADER = /^###\s*Requirement:\s*(.+?)\s*$/i;
export const SCENARIO_HEADER = /^####\s+/;
export const REQUIREMENTS_SECTION = /^##\s+Requirements\s*$/i;
export const TOP_LEVEL = /^##\s+/;

export function normalizeLineEndings(content: string): string {
  return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Маска строк внутри ``` или ~~~ fenced-блоков. */
export function codeFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      mask[i] = true;
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1]!;
      mask[i] = true;
    }
  }
  return mask;
}

export interface RequirementBlock {
  name: string;
  headerLine: string;
  raw: string;
}

export interface SpecStructure {
  /** Всё до строки `## Requirements` (заголовок файла, Purpose и прочие разделы). */
  before: string;
  hasRequirementsHeader: boolean;
  headerLine: string;
  preamble: string;
  blocks: RequirementBlock[];
  /** Всё после раздела Requirements. */
  after: string;
}

export function parseRequirementBlocks(lines: string[], mask: boolean[]): { preamble: string; blocks: RequirementBlock[] } {
  const isReq = (i: number) => !mask[i] && REQUIREMENT_HEADER.test(lines[i]!);
  const isTop = (i: number) => !mask[i] && TOP_LEVEL.test(lines[i]!);
  const blocks: RequirementBlock[] = [];
  let i = 0;
  const preamble: string[] = [];
  while (i < lines.length && !isReq(i)) {
    preamble.push(lines[i]!);
    i += 1;
  }
  while (i < lines.length) {
    if (!isReq(i)) {
      i += 1;
      continue;
    }
    const headerLine = lines[i]!;
    const name = headerLine.match(REQUIREMENT_HEADER)![1]!.trim();
    const buf = [headerLine];
    i += 1;
    while (i < lines.length && !isReq(i) && !isTop(i)) {
      buf.push(lines[i]!);
      i += 1;
    }
    blocks.push({ name, headerLine, raw: buf.join('\n').trimEnd() });
  }
  return { preamble: preamble.join('\n').trimEnd(), blocks };
}

export function extractRequirementsSection(content: string): SpecStructure {
  const lines = normalizeLineEndings(content).split('\n');
  const mask = codeFenceMask(lines);
  const headerIndex = lines.findIndex((l, i) => !mask[i] && REQUIREMENTS_SECTION.test(l));
  if (headerIndex === -1) {
    return { before: lines.join('\n'), hasRequirementsHeader: false, headerLine: '## Requirements', preamble: '', blocks: [], after: '' };
  }
  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (!mask[i] && TOP_LEVEL.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = parseRequirementBlocks(lines.slice(headerIndex + 1, end), mask.slice(headerIndex + 1, end));
  return {
    before: lines.slice(0, headerIndex).join('\n'),
    hasRequirementsHeader: true,
    headerLine: lines[headerIndex]!,
    preamble: body.preamble,
    blocks: body.blocks,
    after: lines.slice(end).join('\n'),
  };
}

export function renderSpec(structure: SpecStructure): string {
  const parts: string[] = [];
  const before = structure.before.trimEnd();
  if (before) parts.push(before, '');
  parts.push(structure.headerLine);
  if (structure.preamble.trim()) parts.push(structure.preamble, '');
  else parts.push('');
  for (const b of structure.blocks) parts.push(b.raw, '');
  const after = structure.after.trim();
  if (after) parts.push(after, '');
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Сценарии блока требования: любые `#### ` заголовки, как в OpenSpec. */
export function parseScenarios(raw: string): Scenario[] {
  const lines = raw.split('\n');
  const mask = codeFenceMask(lines);
  const out: Scenario[] = [];
  let i = 0;
  while (i < lines.length) {
    if (mask[i] || !SCENARIO_HEADER.test(lines[i]!)) {
      i += 1;
      continue;
    }
    const title = lines[i]!.replace(SCENARIO_HEADER, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^Scenario:\s*/i, '').trim();
    i += 1;
    const body: string[] = [];
    while (i < lines.length && (mask[i] || !SCENARIO_HEADER.test(lines[i]!))) {
      body.push(lines[i]!);
      i += 1;
    }
    const description = body.join('\n').trim();
    out.push({ id: slugify(title), title, ...(description ? { description } : {}) });
  }
  return out;
}

/** Нормативный текст: строки между заголовком требования и первым сценарием. */
export function requirementText(raw: string): string {
  const lines = raw.split('\n').slice(1);
  const mask = codeFenceMask(lines);
  const firstScenario = lines.findIndex((l, i) => !mask[i] && SCENARIO_HEADER.test(l));
  return (firstScenario === -1 ? lines : lines.slice(0, firstScenario)).join('\n').trim();
}

export function blockToRequirement(block: RequirementBlock): Requirement {
  const text = requirementText(block.raw);
  return { id: slugify(block.name), title: block.name, ...(text ? { text } : {}), scenarios: parseScenarios(block.raw), raw: block.raw };
}

/** Заголовок `# … Specification` и текст `## Purpose` из части до Requirements. */
export function parseHead(before: string, fallbackTitle: string): { title: string; purpose?: string } {
  const lines = before.split('\n');
  const mask = codeFenceMask(lines);
  let title = fallbackTitle;
  const h1 = lines.findIndex((l, i) => !mask[i] && /^#\s+/.test(l));
  if (h1 !== -1) title = lines[h1]!.replace(/^#\s+/, '').replace(/\s+Specification\s*$/i, '').trim() || fallbackTitle;
  const purposeIndex = lines.findIndex((l, i) => !mask[i] && /^##\s+Purpose\s*$/i.test(l));
  if (purposeIndex === -1) return { title };
  const body: string[] = [];
  for (let i = purposeIndex + 1; i < lines.length; i += 1) {
    if (!mask[i] && TOP_LEVEL.test(lines[i]!)) break;
    body.push(lines[i]!);
  }
  const purpose = body.join('\n').trim();
  return purpose ? { title, purpose } : { title };
}

export function parseSpecFile(content: string, capabilityId: string, source: string): Capability {
  const structure = extractRequirementsSection(content);
  const head = parseHead(structure.before, titleFromId(capabilityId));
  return {
    id: capabilityId,
    title: head.title,
    ...(head.purpose ? { purpose: head.purpose } : {}),
    requirements: structure.blocks.map(blockToRequirement),
    source,
  };
}

/** `identity/user-auth` → `User Auth`. */
export function titleFromId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** Требование из внутренней модели в блок OpenSpec, если нет исходного raw. */
export function renderRequirement(req: Requirement): string {
  if (req.raw) return req.raw.trimEnd();
  const parts = [`### Requirement: ${req.title}`];
  if (req.text) parts.push(req.text.trim());
  for (const s of req.scenarios) {
    parts.push('', `#### Scenario: ${s.title}`);
    if (s.description) parts.push(s.description.trim());
  }
  return parts.join('\n').trimEnd();
}
