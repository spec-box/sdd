/**
 * Текстовый снимок дерева доступности для агента: роли, имена, состояния и ссылки `[eN]`
 * на элементы, с которыми можно взаимодействовать. Чистая функция над узлами puppeteer.
 */
export interface AXNodeLike {
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  selected?: boolean;
  disabled?: boolean;
  focused?: boolean;
  expanded?: boolean;
  required?: boolean;
  level?: number;
  url?: string;
  children?: AXNodeLike[];
}

export interface RenderedSnapshot {
  text: string;
  refs: Map<string, AXNodeLike>;
  count: number;
  truncated: boolean;
}

export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'slider',
  'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'menubutton', 'togglebutton',
]);

const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak']);
const CONTAINER_ROLES = new Set(['RootWebArea', 'WebArea', 'document', 'Iframe', 'iframe']);

export interface RenderOptions {
  interactiveOnly?: boolean;
  maxChars?: number;
  maxNameLength?: number;
}

export function renderSnapshot(root: AXNodeLike | null, opts: RenderOptions = {}): RenderedSnapshot {
  const maxChars = opts.maxChars ?? 40_000;
  const maxName = opts.maxNameLength ?? 80;
  const refs = new Map<string, AXNodeLike>();
  const lines: string[] = [];
  let count = 0;
  const visit = (node: AXNodeLike, depth: number): void => {
    const interactive = INTERACTIVE_ROLES.has(node.role);
    const skip = SKIP_ROLES.has(node.role) || (CONTAINER_ROLES.has(node.role) && depth > 0);
    const silentText = node.role === 'StaticText' || node.role === 'text';
    let nextDepth = depth;
    if (interactive) {
      count += 1;
      const ref = `e${count}`;
      refs.set(ref, node);
      lines.push(`${'  '.repeat(depth)}[${ref}] ${describe(node, maxName)}`);
      nextDepth = depth + 1;
    } else if (!skip && !opts.interactiveOnly && !(silentText && !node.name)) {
      if (!(silentText && depth > 0 && isTrivialText(node))) {
        lines.push(`${'  '.repeat(depth)}${describe(node, maxName)}`);
        nextDepth = depth + 1;
      }
    } else if (!skip && depth === 0) {
      nextDepth = depth;
    }
    for (const child of node.children ?? []) visit(child, nextDepth);
  };
  if (root) visit(root, 0);
  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n… (снимок обрезан до ${maxChars} символов: используйте --interactive или --root)`;
    truncated = true;
  }
  return { text, refs, count, truncated };
}

function isTrivialText(node: AXNodeLike): boolean {
  return !node.name || node.name.trim().length === 0;
}

function describe(node: AXNodeLike, maxName: number): string {
  const parts: string[] = [node.role === 'StaticText' ? 'text' : node.role];
  if (node.name) parts.push(`"${clip(node.name, maxName)}"`);
  if (node.role === 'heading' && node.level) parts.push(`(h${node.level})`);
  if (node.value !== undefined && node.value !== '') parts.push(`value="${clip(String(node.value), maxName)}"`);
  if (node.url && node.role === 'link') parts.push(`→ ${clip(node.url, 120)}`);
  const flags: string[] = [];
  if (node.checked === true) flags.push('checked');
  if (node.checked === 'mixed') flags.push('mixed');
  if (node.pressed === true) flags.push('pressed');
  if (node.selected) flags.push('selected');
  if (node.disabled) flags.push('disabled');
  if (node.focused) flags.push('focused');
  if (node.expanded === true) flags.push('expanded');
  if (node.expanded === false) flags.push('collapsed');
  if (node.required) flags.push('required');
  if (flags.length) parts.push(`[${flags.join(', ')}]`);
  if (node.description) parts.push(`— ${clip(node.description, maxName)}`);
  return parts.join(' ');
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
