import { describe, expect, it } from 'vitest';
import { parseTasks, taskProgress } from '../src/core/tasks.js';

describe('tasks', () => {
  it('считает флажки', () => {
    const md = '## 1\n- [ ] 1.1 a\n- [x] 1.2 b\n* [X] 1.3 c\n- нет флажка\n';
    expect(parseTasks(md)).toHaveLength(3);
    expect(taskProgress(md)).toEqual({ total: 3, done: 2, remaining: 1 });
  });
});
