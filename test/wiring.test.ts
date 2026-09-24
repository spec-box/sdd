import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { parseAnalogFromDesign, wiringGaps } from '../src/core/wiring.js';
import { RESULT, git, read, tempProject, write } from './helpers.js';

describe('подключение по образцу', () => {
  it('находит файлы, где образец зарегистрирован, а новый модуль нет', () => {
    const root = tempProject();
    write(root, 'Plugins.Cron/Cron.csproj', '<Project/>');
    write(root, 'Host/Host.csproj', '<ProjectReference Include="..\\Plugins.Cron\\Plugins.Cron.csproj" />');
    write(root, 'Host/appsettings.json', '{"assemblies": ["Plugins.Cron", "Plugins.Chats"]}');
    write(root, 'App.sln', 'Project = "Plugins.Cron"\nProject = "Plugins.Chats"\n');
    write(root, 'docs/plugins.md', 'Plugins.Cron описан тут');
    write(root, 'Plugins.Chats/Chats.csproj', '<Project/>');
    git(root, ['add', '-A']);
    const r = wiringGaps(root, 'Plugins.Cron', 'Plugins.Chats');
    expect(r.registrationFiles.sort()).toEqual(['App.sln', 'Host/Host.csproj', 'Host/appsettings.json']);
    expect(r.gaps.map((g) => g.file)).toEqual(['Host/Host.csproj']);
    expect(wiringGaps(root, 'Plugins.Cron', 'Plugins.Chats', ['Host/Host.csproj']).gaps).toEqual([]);
  });

  it('читает образец из design.md и верификация падает при пропуске', async () => {
    const design = '## Единообразие\n\n- Образец: `Plugins.Cron`\n- Новый модуль: `Plugins.Chats`\n- Исключения подключения: —\n';
    expect(parseAnalogFromDesign(design)).toEqual({ analog: 'Plugins.Cron', fresh: 'Plugins.Chats', exceptions: [] });
    const root = tempProject();
    write(root, 'Host/Host.csproj', '<ProjectReference Include="Plugins.Cron" />');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'host']);
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'wire', title: 't', request: 'r', autonomy: 'autonomous' });
    write(root, path.relative(root, path.join(dir, 'design.md')), design);
    const c = loadChange(dir);
    c.phase = 'verify';
    saveChange(dir, c);
    // advisory: верификатор не рассмотрел файл → пункт W1 PARTIAL для ревьюера, фаза завершается
    const out = await applyReport({ root, config, dir, change: loadChange(dir), role: 'verifier', phase: 'verify', markdown: RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'), adapter });
    expect(out.phaseCompleted).toBe(true);
    const checks = loadChange(dir).verification!.checks;
    expect(checks.find((c) => c.id === 'W1')).toMatchObject({ result: 'PARTIAL' });
    expect(checks.find((c) => c.id === 'W1')!.purpose).toContain('Host/Host.csproj');
    // ревьюер обязан распорядиться W1
    const rev = await applyReport({ root, config, dir, change: loadChange(dir), role: 'reviewer', phase: 'review', markdown: RESULT('готово', 'delivery_narrative: { title: "x", delta: "y", why: "z" }\n'), adapter });
    expect(rev.diagnostics.map((d) => d.code)).toContain('REVIEW_DISPOSITION_MISSING');
    // верификатор сам закрыл файл → синтетического пункта нет
    const c2 = loadChange(dir);
    c2.phase = 'verify';
    saveChange(dir, c2);
    const own = await applyReport({ root, config, dir, change: loadChange(dir), role: 'verifier', phase: 'verify', markdown: RESULT('готово', 'checks:\n  - { id: V1, result: PASS, purpose: "регистрация в Host/Host.csproj не нужна: хост не грузит этот тип модулей", evidence: "Host/Host.csproj" }\n'), adapter });
    expect(own.phaseCompleted).toBe(true);
    expect(loadChange(dir).verification!.checks.some((c) => c.id.startsWith('W'))).toBe(false);
    // strict: ошибка верификации
    write(root, '.sbox/config.yaml', `${read(root, '.sbox/config.yaml')}\nwiring:\n  strict: true\n`);
    const strictConfig = loadConfig(root);
    const c3 = loadChange(dir);
    c3.phase = 'verify';
    saveChange(dir, c3);
    const strict = await applyReport({ root, config: strictConfig, dir, change: loadChange(dir), role: 'verifier', phase: 'verify', markdown: RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'), adapter });
    expect(strict.diagnostics.map((d) => d.code)).toContain('WIRING_MISSING');
    expect(strict.phaseCompleted).toBe(false);
  });
});
