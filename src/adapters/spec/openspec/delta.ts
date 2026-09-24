import { diag, type Diagnostic } from '../../../core/diagnostics.js';
import type { Capability, DeltaOp, Requirement, SpecDelta } from '../../../core/spec-model.js';
import { blockToRequirement, codeFenceMask, extractRequirementsSection, normalizeLineEndings, parseRequirementBlocks, parseScenarios, renderRequirement, renderSpec, REQUIREMENT_HEADER, titleFromId, TOP_LEVEL, type RequirementBlock } from './parser.js';

/**
 * Дельта OpenSpec: секции `## ADDED | MODIFIED | REMOVED | RENAMED Requirements` и `## Purpose` для новой capability.
 * Разбор повторяет правила OpenSpec: секции могут повторяться, регистр заголовков не важен,
 * REMOVED принимает блоки `### Requirement:` или маркированный список, RENAMED пары FROM/TO.
 */
interface Section {
  title: string;
  lines: string[];
  mask: boolean[];
}

function splitSections(content: string): { head: string[]; headMask: boolean[]; sections: Section[] } {
  const lines = normalizeLineEndings(content).split('\n');
  const mask = codeFenceMask(lines);
  const indices: { title: string; index: number }[] = [];
  lines.forEach((l, i) => {
    const m = !mask[i] && l.match(/^##\s+(.+?)\s*$/);
    if (m) indices.push({ title: m[1]!, index: i });
  });
  const sections: Section[] = indices.map((cur, k) => {
    const end = indices[k + 1]?.index ?? lines.length;
    return { title: cur.title, lines: lines.slice(cur.index + 1, end), mask: mask.slice(cur.index + 1, end) };
  });
  const headEnd = indices[0]?.index ?? lines.length;
  return { head: lines.slice(0, headEnd), headMask: mask.slice(0, headEnd), sections };
}

const DELTA_SECTION = /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements$/i;

export interface ParsedOpenSpecDelta {
  delta: SpecDelta;
  /** Разделы, не относящиеся к дельте (для диагностики). */
  unknownSections: string[];
  /** Заголовки третьего уровня внутри секций, не являющиеся `### Requirement:` (OpenSpec их пропускает). */
  skippedHeaders: string[];
}

export function parseOpenSpecDelta(content: string, capabilityId: string, source: string, truthIds: Set<string>): ParsedOpenSpecDelta {
  const { sections } = splitSections(content);
  const ops: DeltaOp[] = [];
  const unknownSections: string[] = [];
  const skippedHeaders: string[] = [];
  let purpose: string | undefined;
  const blocksOf = (s: Section): RequirementBlock[] => {
    const parsed = parseRequirementBlocks(s.lines, s.mask);
    s.lines.forEach((l, i) => {
      if (!s.mask[i] && /^###\s+/.test(l) && !REQUIREMENT_HEADER.test(l)) skippedHeaders.push(l.trim());
    });
    return parsed.blocks;
  };
  const toReq = (b: RequirementBlock): Requirement => blockToRequirement(b);
  const renamed: { from: string; to: string }[] = [];
  const removed: DeltaOp[] = [];
  const modified: DeltaOp[] = [];
  const added: DeltaOp[] = [];
  for (const s of sections) {
    if (/^Purpose$/i.test(s.title)) {
      const text = s.lines.join('\n').trim();
      if (text) purpose = text;
      continue;
    }
    const m = s.title.match(DELTA_SECTION);
    if (!m) {
      unknownSections.push(s.title);
      continue;
    }
    const kind = m[1]!.toUpperCase();
    if (kind === 'ADDED') for (const b of blocksOf(s)) added.push({ op: 'add-requirement', requirement: toReq(b) });
    if (kind === 'MODIFIED') for (const b of blocksOf(s)) modified.push({ op: 'modify-requirement', requirement: toReq(b) });
    if (kind === 'REMOVED') {
      const blocks = blocksOf(s);
      if (blocks.length > 0) {
        for (const b of blocks) {
          const reason = b.raw.match(/\*\*Reason\*\*\s*:?\s*(.+)/i)?.[1]?.trim();
          const migration = b.raw.match(/\*\*Migration\*\*\s*:?\s*(.+)/i)?.[1]?.trim();
          removed.push({ op: 'remove-requirement', requirementTitle: b.name, ...(reason ? { reason } : {}), ...(migration ? { migration } : {}) });
        }
      }
      s.lines.forEach((l, i) => {
        const bullet = !s.mask[i] && l.match(/^\s*[-*+]\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        if (bullet) removed.push({ op: 'remove-requirement', requirementTitle: bullet[1]!.trim() });
      });
    }
    if (kind === 'RENAMED') {
      let cur: { from?: string; to?: string } = {};
      s.lines.forEach((l, i) => {
        if (s.mask[i]) return;
        const from = l.match(/^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        const to = l.match(/^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        if (from) cur.from = from[1]!.trim();
        else if (to) {
          cur.to = to[1]!.trim();
          if (cur.from && cur.to) {
            renamed.push({ from: cur.from, to: cur.to });
            cur = {};
          }
        }
      });
    }
  }
  for (const r of renamed) ops.push({ op: 'rename-requirement', from: r.from, to: r.to });
  ops.push(...removed, ...modified, ...added);
  const delta: SpecDelta = { capabilityId, isNew: !truthIds.has(capabilityId), ops, source, ...(purpose ? { purpose } : {}) };
  return { delta, unknownSections, skippedHeaders };
}

export const MIN_PURPOSE_LENGTH = 50;

export function validateOpenSpecDeltas(truth: Capability[], deltas: SpecDelta[], extras: Map<string, ParsedOpenSpecDelta> = new Map()): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map(truth.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const delta of deltas) {
    const t = delta.source;
    if (!/^[a-z0-9]+(?:[-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-][a-z0-9]+)*)*$/.test(delta.capabilityId)) {
      out.push(diag('error', 'DELTA_CAPABILITY_ID', `Путь capability «${delta.capabilityId}» должен быть в kebab-case, сегменты через /`, t));
    }
    if (seen.has(delta.capabilityId)) out.push(diag('error', 'DELTA_DUPLICATE', `Дельта для ${delta.capabilityId} встречается дважды`, t));
    seen.add(delta.capabilityId);
    const extra = extras.get(delta.source);
    for (const h of extra?.skippedHeaders ?? []) out.push(diag('info', 'DELTA_SKIPPED_HEADER', `Заголовок «${h}» не является \`### Requirement:\` и будет пропущен`, t));
    for (const s of extra?.unknownSections ?? []) out.push(diag('warning', 'DELTA_UNKNOWN_SECTION', `Раздел «## ${s}» не относится к дельте и будет проигнорирован`, t));
    const cap = byId.get(delta.capabilityId);
    if (delta.ops.length === 0) out.push(diag('error', 'DELTA_EMPTY', 'Дельта без операций ADDED, MODIFIED, REMOVED или RENAMED', t));
    if (!cap) {
      if (!delta.purpose) out.push(diag('error', 'DELTA_NEW_PURPOSE', `Новая capability ${delta.capabilityId} без раздела \`## Purpose\``, t));
      else if (delta.purpose.length < MIN_PURPOSE_LENGTH) out.push(diag('warning', 'DELTA_NEW_PURPOSE', `Purpose короче ${MIN_PURPOSE_LENGTH} символов`, t));
      for (const op of delta.ops) if (op.op !== 'add-requirement') out.push(diag('error', 'DELTA_NEW_OP', `Для новой capability допустим только ADDED, найдено ${op.op}`, t));
    } else {
      if (delta.purpose) out.push(diag('info', 'DELTA_PURPOSE_IGNORED', 'Purpose существующей capability не меняется дельтой; правьте spec.md истины', t));
      const titles = new Set(cap.requirements.map((r) => r.title));
      const renamedFrom = new Set(delta.ops.filter((o) => o.op === 'rename-requirement').map((o) => (o as { from: string }).from));
      const renamedTo = new Set(delta.ops.filter((o) => o.op === 'rename-requirement').map((o) => (o as { to: string }).to));
      for (const op of delta.ops) {
        switch (op.op) {
          case 'rename-requirement':
            if (!titles.has(op.from)) out.push(diag('error', 'DELTA_RENAME_FROM', `RENAMED: требования «${op.from}» нет в истине`, t));
            if (titles.has(op.to)) out.push(diag('error', 'DELTA_RENAME_TO', `RENAMED: требование «${op.to}» уже существует`, t));
            break;
          case 'remove-requirement':
            if (!titles.has(op.requirementTitle)) out.push(diag('error', 'DELTA_REMOVE_MISSING', `REMOVED: требования «${op.requirementTitle}» нет в истине`, t));
            if (renamedFrom.has(op.requirementTitle)) out.push(diag('error', 'DELTA_REMOVE_RENAMED', `REMOVED: «${op.requirementTitle}» одновременно переименовано`, t));
            if (!op.reason) out.push(diag('warning', 'DELTA_REMOVE_REASON', `REMOVED «${op.requirementTitle}» без **Reason**`, t));
            break;
          case 'modify-requirement':
            if (renamedFrom.has(op.requirement.title)) out.push(diag('error', 'DELTA_MODIFY_RENAMED', `MODIFIED: «${op.requirement.title}» переименовано, опишите под новым заголовком TO`, t));
            else if (!titles.has(op.requirement.title) && !renamedTo.has(op.requirement.title)) out.push(diag('error', 'DELTA_MODIFY_MISSING', `MODIFIED: требования «${op.requirement.title}» нет в истине`, t, 'Для нового требования используйте ADDED.'));
            else {
              const current = cap.requirements.find((r) => r.title === op.requirement.title || renamedFrom.has(r.title));
              if (current) {
                const incoming = new Set(op.requirement.scenarios.map((s) => s.title));
                const dropped = current.scenarios.filter((s) => !incoming.has(s.title)).map((s) => s.title);
                if (dropped.length > 0) out.push(diag('warning', 'DELTA_MODIFY_DROPS_SCENARIOS', `MODIFIED «${op.requirement.title}» теряет сценарии: ${dropped.join(', ')}`, t, 'MODIFIED заменяет блок целиком; чтобы убрать сценарий, используйте REMOVED + ADDED.'));
              }
            }
            break;
          case 'add-requirement':
            if (titles.has(op.requirement.title)) out.push(diag('error', 'DELTA_ADD_EXISTS', `ADDED: требование «${op.requirement.title}» уже есть в истине; используйте MODIFIED`, t));
            break;
        }
      }
    }
    const names = new Set<string>();
    for (const op of delta.ops) {
      if (op.op !== 'add-requirement' && op.op !== 'modify-requirement') continue;
      const r = op.requirement;
      if (names.has(r.title)) out.push(diag('error', 'DELTA_REQUIREMENT_DUPLICATE', `Требование «${r.title}» встречается дважды`, t));
      names.add(r.title);
      if (r.scenarios.length === 0) out.push(diag('error', 'DELTA_NO_SCENARIO', `Требование «${r.title}» без сценария (\`#### Scenario:\`)`, t));
      if (!r.text || !/\b(SHALL|MUST)\b/.test(r.text)) out.push(diag('warning', 'DELTA_NO_SHALL', `Требование «${r.title}» без нормативного текста с SHALL или MUST`, t));
      if (r.raw && /^###\s+Scenario:/im.test(r.raw)) out.push(diag('error', 'DELTA_SCENARIO_LEVEL', `Сценарий в «${r.title}» оформлен тремя #: нужно ровно \`#### Scenario:\``, t));
    }
  }
  return out;
}

function normalizeBlock(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

/** Дубликаты заголовков требований и сценариев в истине: их появление ломает последующие MODIFIED и REMOVED. */
export function checkOpenSpecTruth(truth: Capability[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const cap of truth) {
    const seen = new Map<string, number>();
    for (const r of cap.requirements) seen.set(r.title, (seen.get(r.title) ?? 0) + 1);
    for (const [title, n] of seen) if (n > 1) out.push(diag('error', 'TRUTH_DUPLICATE_REQUIREMENT', `Требование «${title}» встречается ${n} раз`, cap.source ?? cap.id));
    for (const r of cap.requirements) {
      const sc = new Map<string, number>();
      for (const sn of r.scenarios) sc.set(sn.title, (sc.get(sn.title) ?? 0) + 1);
      for (const [title, n] of sc) if (n > 1) out.push(diag('warning', 'TRUTH_DUPLICATE_SCENARIO', `Сценарий «${title}» в требовании «${r.title}» встречается ${n} раз`, cap.source ?? cap.id));
    }
  }
  return out;
}

/** Текстовое применение дельты к содержимому spec.md: неизменённые части сохраняются байт в байт. */
export function applyOpenSpecDelta(current: string | null, delta: SpecDelta): string {
  if (current === null) {
    const title = delta.title ?? titleFromId(delta.capabilityId);
    const purpose = delta.purpose ?? `TBD - created by archiving change. Update Purpose after archive.`;
    const blocks = delta.ops.filter((o) => o.op === 'add-requirement').map((o) => renderRequirement((o as { requirement: Requirement }).requirement));
    return `# ${title} Specification\n\n## Purpose\n${purpose}\n\n## Requirements\n\n${blocks.join('\n\n')}\n`;
  }
  const structure = extractRequirementsSection(current);
  let blocks = [...structure.blocks];
  const find = (name: string) => blocks.findIndex((b) => b.name === name);
  for (const op of delta.ops) {
    switch (op.op) {
      case 'rename-requirement': {
        const i = find(op.from);
        if (i === -1) break;
        const b = blocks[i]!;
        const newHeader = b.headerLine.replace(REQUIREMENT_HEADER, (_m, _n) => `### Requirement: ${op.to}`);
        blocks[i] = { name: op.to, headerLine: newHeader, raw: b.raw.replace(b.headerLine, newHeader) };
        break;
      }
      case 'remove-requirement': {
        const i = find(op.requirementTitle);
        if (i !== -1) blocks.splice(i, 1);
        break;
      }
      case 'modify-requirement': {
        const i = find(op.requirement.title);
        const raw = renderRequirement(op.requirement);
        if (i === -1) blocks.push({ name: op.requirement.title, headerLine: `### Requirement: ${op.requirement.title}`, raw });
        else blocks[i] = { name: op.requirement.title, headerLine: `### Requirement: ${op.requirement.title}`, raw };
        break;
      }
      case 'add-requirement': {
        const raw = renderRequirement(op.requirement);
        const existing = find(op.requirement.title);
        if (existing !== -1) {
          // Повторное применение той же дельты: одинаковый блок пропускаем, другой считаем конфликтом.
          if (normalizeBlock(blocks[existing]!.raw) === normalizeBlock(raw)) break;
          throw new Error(`DELTA_ADD_CONFLICT: требование «${op.requirement.title}» уже есть в ${delta.capabilityId} с другим содержимым; используйте MODIFIED`);
        }
        blocks.push({ name: op.requirement.title, headerLine: `### Requirement: ${op.requirement.title}`, raw });
        break;
      }
    }
  }
  return renderSpec({ ...structure, blocks, hasRequirementsHeader: true });
}

export { parseScenarios, TOP_LEVEL };
