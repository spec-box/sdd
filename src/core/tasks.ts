/** Разбор чекбоксов tasks.md: строки вида `- [ ] 1.1 ...` и `- [x] ...`. */
export interface TaskItem {
  line: number;
  done: boolean;
  text: string;
}

export function parseTasks(markdown: string): TaskItem[] {
  const items: TaskItem[] = [];
  markdown.split(/\r?\n/).forEach((line, index) => {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (m) items.push({ line: index + 1, done: m[1] !== ' ', text: (m[2] ?? '').trim() });
  });
  return items;
}

export function taskProgress(markdown: string): { total: number; done: number; remaining: number } {
  const items = parseTasks(markdown);
  const done = items.filter((t) => t.done).length;
  return { total: items.length, done, remaining: items.length - done };
}
