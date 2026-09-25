import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { installHostMaterials } from '../../adapters/host/index.js';
import { defaultConfig, loadConfig, saveConfig } from '../../core/config.js';
import { SboxError } from '../../core/errors.js';
import { assetsDir, sboxDir, exists, readText, today, writeText } from '../../core/paths.js';
import { DOC_CATEGORIES } from '../../core/project-docs.js';
import { WIKI_README } from '../../core/wiki.js';
import { emit, emitError } from '../output.js';

const GITIGNORE_BLOCK = ['# sbox: служебные файлы запусков', '**/.sbox/**/.lock', '**/.stop', '**/change.yaml.*.tmp', '**/runs/run.log', '**/runs/r*/packet.json'];

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Создать .sbox/: конфиг, шаблоны проектной документации, каталог изменений; при --host сразу материалы для хоста')
    .option('--adapter <name>', 'адаптер спецификаций: spec-box | openspec; при существующем конфиге меняет только его')
    .option('--host <name>', 'сразу установить материалы хоста: claude | codex')
    .option('--force', 'перезаписать конфиг целиком (документация не трогается)')
    .option('--reset-docs', 'перезаписать заполненную документацию шаблонами')
    .action((opts: { adapter?: string; host?: string; force?: boolean; resetDocs?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const root = path.resolve(g.cwd ?? process.cwd());
        const adapter = (opts.adapter ?? (exists(path.join(root, 'openspec', 'specs')) && !exists(path.join(root, '.tms.json')) ? 'openspec' : 'spec-box')) as 'spec-box' | 'openspec';
        if (adapter !== 'spec-box' && adapter !== 'openspec') throw new SboxError('ADAPTER_UNKNOWN', `Неизвестный адаптер ${String(adapter)}; доступны spec-box и openspec.`);
        const dir = sboxDir(root);
        const created: string[] = [];
        const notes: string[] = [];

        const configFile = path.join(dir, 'config.yaml');
        if (exists(configFile) && !opts.force) {
          // Повторный запуск: обновляем только адаптер и связанные пути, остальное сохраняем.
          const current = loadConfig(root);
          if (opts.adapter && current.spec.adapter !== adapter) {
            current.spec.adapter = adapter;
            if (adapter === 'openspec') {
              const activeChanges = exists(path.join(root, current.changes.dir)) ? fs.readdirSync(path.join(root, current.changes.dir)).filter((n) => n !== 'archive' && n !== '.gitkeep') : [];
              if (activeChanges.length === 0) {
                current.changes.dir = 'openspec/changes';
                notes.push('changes.dir переключён на openspec/changes для совместимости с CLI OpenSpec.');
              } else {
                notes.push(`В ${current.changes.dir} есть изменения (${activeChanges.join(', ')}): changes.dir оставлен; перенесите их в openspec/changes и поправьте конфиг вручную, если нужна совместимость с CLI OpenSpec.`);
              }
              for (const sub of ['specs', 'changes', 'changes/archive']) {
                const keep = path.join(root, 'openspec', sub, '.gitkeep');
                if (!exists(path.join(root, 'openspec', sub))) {
                  writeText(keep, '');
                  created.push(keep);
                }
              }
              const staleKeep = path.join(root, 'specs', '.gitkeep');
              if (exists(staleKeep) && fs.readdirSync(path.join(root, 'specs')).length === 1) {
                fs.rmSync(path.join(root, 'specs'), { recursive: true, force: true });
                notes.push('Удалён пустой каталог specs/, созданный для spec-box.');
              }
            }
            saveConfig(root, current);
            created.push(configFile);
            notes.push(`Адаптер спецификаций переключён на ${adapter}; проверьте раздел «Истина спецификаций» в .sbox/project/overview.md.`);
          } else {
            notes.push('Конфиг уже есть и не изменён: укажите --adapter для смены адаптера или --force для перезаписи.');
          }
        } else {
          const config = defaultConfig(adapter);
          if (adapter === 'openspec') {
            // Совместимость с CLI OpenSpec: изменения живут в openspec/changes, истина в openspec/specs.
            config.changes.dir = 'openspec/changes';
            for (const sub of ['specs', 'changes', 'changes/archive']) {
              const keep = path.join(root, 'openspec', sub, '.gitkeep');
              if (!exists(path.join(root, 'openspec', sub))) {
                writeText(keep, '');
                created.push(keep);
              }
            }
            notes.push('Адаптер openspec: истина в openspec/specs/<capability>/spec.md, изменения в openspec/changes/<id>/ (совместимо с openspec CLI).');
          } else if (!exists(path.join(root, '.tms.json'))) {
            // Нет конфига spec-box: истина будет жить в specs/*.spec-box.yml прямо в репозитории.
            config.spec['spec-box'].files = ['specs/**/*.spec-box.yml'];
            const keep = path.join(root, 'specs', '.gitkeep');
            if (!exists(keep)) {
              writeText(keep, '');
              created.push(keep);
            }
            notes.push('Файла .tms.json нет: спецификации ожидаются в specs/**/*.spec-box.yml (поле spec.spec-box.files в конфиге).');
          }
          saveConfig(root, config);
          created.push(configFile);
        }

        const date = today();
        for (const category of DOC_CATEGORIES) {
          const target = path.join(dir, 'project', category.file);
          if (exists(target) && !opts.resetDocs) continue;
          writeText(target, readText(path.join(assetsDir(), 'project', category.file)).replace(/\{\{DATE\}\}/g, date));
          created.push(target);
        }
        const decisionsReadme = path.join(dir, 'project', 'decisions', 'README.md');
        if (!exists(decisionsReadme)) {
          writeText(decisionsReadme, readText(path.join(assetsDir(), 'project', 'decisions.README.md')));
          created.push(decisionsReadme);
        }
        const wikiReadme = path.join(dir, 'wiki', 'README.md');
        if (!exists(wikiReadme)) {
          writeText(wikiReadme, WIKI_README);
          created.push(wikiReadme);
        }
        for (const sub of ['changes', 'changes/archive', 'discovery']) {
          const keep = path.join(dir, sub, '.gitkeep');
          if (!exists(keep)) {
            fs.mkdirSync(path.dirname(keep), { recursive: true });
            fs.writeFileSync(keep, '');
          }
        }

        const gitignore = path.join(root, '.gitignore');
        const current = exists(gitignore) ? readText(gitignore) : '';
        const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
        const missing = GITIGNORE_BLOCK.filter((l) => !l.startsWith('#') && !lines.has(l));
        if (missing.length > 0) {
          const header = current.includes('# sbox:') ? '' : `${GITIGNORE_BLOCK[0]}\n`;
          writeText(gitignore, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${header}${missing.join('\n')}\n`);
          created.push(gitignore);
        }

        let hostFiles: string[] = [];
        let hostNext: string | null = null;
        if (opts.host) {
          const result = installHostMaterials(root, opts.host, exists(configFile) ? loadConfig(root) : undefined);
          hostFiles = result.files.map((f) => path.relative(root, f));
          notes.push(...result.notes);
          hostNext = result.next;
        }

        emit(g, { root, adapter, created: created.map((f) => path.relative(root, f)), host: hostFiles, hostNext, notes }, (d) =>
          [
            `Инициализировано в ${d.root} (адаптер ${d.adapter})`,
            ...d.created.map((f) => `  + ${f}`),
            ...d.host.map((f) => `  + ${f}`),
            ...d.notes.map((n) => `  ! ${n}`),
            '',
            'Дальше:',
            '  1. Заполните .sbox/project/*.md (или попросите researcher: `sbox change new` и роль соберёт черновик по коду).',
            '  2. `sbox doctor` — проверка документации и спецификаций.',
            ...(d.hostNext ? [`  3. ${d.hostNext}`] : ['  3. `sbox host install --target claude | codex` — скиллы и агенты для хоста.']),
          ].join('\n'),
        );
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
