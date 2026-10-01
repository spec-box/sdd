# @spec-box/sdd

Инструмент автономной реализации продуктовых фич ИИ-агентами: вы даёте описание фичи, агенты-роли проводят её через исследование, предложение, спецификации, дизайн, тесты, реализацию, верификацию и ревью до пул-реквеста, готового к влитию. Состояние процесса хранится в файлах репозитория продукта.

Проект входит в группу [spec-box](https://github.com/spec-box): инструменты для работы со спецификациями и автотестами. Репозиторий: [github.com/spec-box/sdd](https://github.com/spec-box/sdd).

Замысел и устройство описаны в [docs/design.md](docs/design.md). Ниже то, что уже реализовано (этапы 1 и 2 плана).

## Установка

Требуется Node.js 22. Инструмент ставится глобально из npm и обновляется той же командой:

```bash
npm install -g @spec-box/sdd
sbox --version
```

Для разработки самого @spec-box/sdd: `pnpm install`, `pnpm build` (tsc → dist/), `pnpm test` (vitest), `pnpm dev -- <команда>` запускает CLI через tsx без сборки. Публикация: `npm publish` из корня репозитория, `prepublishOnly` собирает и прогоняет тесты.

## Быстрый старт в проекте продукта

```bash
cd <репозиторий продукта>     # spec-box (.tms.json) или OpenSpec (openspec/specs); адаптер определяется автоматически
sbox init --host claude       # .sbox/config.yaml, шаблоны .sbox/project/*.md, .gitignore, скиллы и агенты Claude Code
# заполнить .sbox/project/*.md
sbox doctor                   # структурная проверка документации, спецификаций и сред запуска
sbox help                     # справка для агентов и людей: указатель тем и руководства инструментов (sbox-contract help, sbox-wiki help, sbox-browser help)
sbox change new add-search --title "Поиск по каталогу" --request "Добавить поле поиска на главную"
sbox next --change add-search # пакет для первой роли (researcher)
```

Дальше цикл ведёт скилл `/sbox-run` в Claude Code или `$sbox-run` в Codex: он вызывает `sbox next`, запускает субагента нужной роли, сдаёт его ответ через `sbox report` и останавливается на гейтах. Гейты решает человек: `sbox approve <gate>` или `sbox reject <gate> --comment "..."`.

## Что где лежит

```text
src/core/        доменная модель, конфиг, состояние изменения (ревизия, lock), машина состояний, схема артефактов,
                 пакет для роли, приём отчёта, change-set, headless-цикл run, доставка и текст PR, гейты через PR,
                 отчёты тестов и покрытие, категории документации и doctor, архивация
src/adapters/    spec/spec-box, spec/openspec — истина и дельты в двух форматах; runner/claude, runner/codex — среды агентов;
                 repo/github, repo/local — хостинг репозитория; host/skills — раскладки скиллов по хостам, host/claude — агенты Claude Code
src/cli/         команды commander: init, doctor, host, change, next, report, approve, reject,
                 status, instructions, validate, archive, log, help
src/contract/    sbox-contract: модель поведения, конфигурация, поиск, дельты и применение
src/wiki/        sbox-wiki: индекс и кеш Markdown, поиск, страницы, ссылки и валидация
src/browser/     sbox-browser: демон с Chrome на сессию, клиент через локальный сокет, команды страницы,
                 снимок дерева доступности со ссылками, поиск и установка браузера, вход человеком, перенос состояния
assets/roles/    определения ролей (Markdown): researcher, planner, tester, implementer, reviewer, verifier…
assets/schema/   граф артефактов по умолчанию и инструкции к ним
assets/skills/   скиллы хостов (единый источник): sbox-run, sbox-approve, sbox-browser; копируются в папку хоста при init и host install
assets/templates/ шаблоны артефактов изменения
assets/project/  шаблоны категорий проектной документации
assets/ci/       шаблоны GitHub Actions и Dockerfile
test/            vitest: парсеры, адаптер spec-box, doctor, полный цикл изменения на фикстуре
docs/design.md   проектный документ
```

## Headless-режим

```bash
sbox run --change add-search --runner claude  # роли выполняет адаптер среды до гейта, блокера или конца
sbox run --change add-search --detach         # в фоне; журнал в .sbox/changes/<id>/runs/run.log
sbox watch --change add-search                # ждать терминального статуса, выход 1 при parked/blocked/stopped
sbox stop --change add-search                 # остановить процесс роли, доставка после этого запрещена
sbox change resume add-search --returns 6     # продолжить после parked с большим бюджетом возвратов
sbox changeset show                           # запечатанный change-set и дрейф рабочей копии
sbox coverage --report jest=reports/jest.json # покрытие утверждений дельт тестами
sbox deliver --check && sbox deliver          # чеклист готовности, архив, коммит, push, пул-реквест
sbox gates poll                               # гейты через комментарии /sbox approve|reject в пул-реквесте
sbox ci install --target github               # workflows для GitHub Actions; --target docker для Dockerfile.sbox
sbox wiring --analog X --new Y                # новый модуль подключён везде, где подключён образец
sbox metrics                                  # время агентов, ожидание человека, запуски, стоимость, вмешательства, оценки
sbox change rate <id> --score 4               # оценка результата человеком
sbox prompt show project-docs                 # промпт для заполнения .sbox/project/*.md под адаптер проекта
```

Модель и effort задаются по профилям отдельно в `runner.claude.profiles` и `runner.codex.profiles`; после правки выполните `sbox host install --target claude`. Среды: `claude` через Claude Agent SDK (нужен `ANTHROPIC_API_KEY` для CI; локально годится вход Claude Code), `codex` через `codex exec` (в конфиге `runner.codex.executable`, например бинарник из ChatGPT.app). Репозиторий: `repo.adapter: github` с токеном в `GITHUB_TOKEN`; `local` только коммитит.

## Профили моделей

Одна политика выбора для headless и материалов Claude Code: роль и оценка сложности определяют профиль `simple`, `medium` или `complex`, затем выбранный раннер подставляет пару `model` + `effort`.

```yaml
runner:
  default: codex
  roleProfiles:             # необязательная фиксация профиля роли
    planner: complex
    challenger: complex
    reviewer: complex
  claude:
    profiles:
      simple:  { model: claude-sonnet-5, effort: low }
      medium:  { model: claude-sonnet-5, effort: medium }
      complex: { model: claude-opus-5, effort: high }
  codex:
    profiles:
      simple:  { model: gpt-5.6-terra, effort: low }
      medium:  { model: gpt-5.6-terra, effort: medium }
      complex: { model: gpt-5.6-sol, effort: high }
```

Пример показывает встроенные значения. Профили можно задавать частично: остальные поля получают дефолты. Доступность конкретной модели и поддержка effort зависят от установленного раннера и учётной записи.

По умолчанию planner/challenger/reviewer используют complex, distiller — simple, остальные — medium. Оценка планировщика `complexity.implementation` переключает tester/implementer: простая → simple, обычная → medium, высокая → complex. Оценка complexity.review сохраняется для аудита, но не ослабляет независимое ревью: reviewer остаётся complex. При возвратах оценка может повышаться. Явный `roleProfiles.<роль>` фиксирует профиль и имеет приоритет над автоматическим выбором. Размер small/normal/large определяет артефакты и не меняет профиль сам по себе.

```bash
sbox models --json                           # обе среды, профили по ролям
sbox models --change add-search --json       # с учётом сложности изменения
sbox next --change add-search --runner claude --brief --json
sbox host install --target claude            # обновить определения агентов
```

`next` возвращает `execution` с раннером, профилем, моделью, effort и именем агента выбранного хоста. `/sbox-run` использует это имя; устанавливаются варианты `sbox-<роль>-simple|medium|complex` и базовый `sbox-<роль>`. При изменении профиля/модели/effort предыдущая сессия не продолжается. Для Codex генерируются `.codex/agents/*.toml`, устанавливается общий скилл в `.agents/skills/sbox-run` и добавляется управляемый раздел `AGENTS.md`. Пользовательский `.codex/config.toml` не меняется. После установки откройте новую сессию Codex в доверенном проекте. Если клиент не поддерживает выбор пользовательских агентов, скилл использует `sbox run --runner codex --max-runs 1` с теми же настройками.

**Миграция:** общие `runner.models`, `runner.efforts`, `runner.defaultEffort` удалены и вызывают понятную ошибку конфигурации. Перенесите настройки в профили нужного раннера, при необходимости задайте roleProfiles, удалите старые поля и переустановите материалы хоста. Автоматический перенос не выполняется: старая таблица не указывает, какому раннеру принадлежит модель.

## Браузер для проверки интерфейса

Отдельный бинарник `sbox-browser` даёт агентам и людям управляемый Chrome: верификатор проверяет затронутую страницу по-настоящему, а не только сборкой, исследователь и тестировщик смотрят текущий интерфейс глазами пользователя. Пакет браузер не скачивает: `puppeteer-core` подключается к тому, что есть, а установка отдельная и необязательная.

```bash
sbox-browser doctor                                   # какой браузер будет использован и откуда
sbox-browser install                                  # скачать Chrome for Testing в ~/.sbox/browser/cache (по желанию)
sbox-browser install --browser chrome-headless-shell  # лёгкий вариант только для headless
sbox-browser login https://app.local --profile app    # человек входит в окне; вход остаётся в профиле
sbox-browser goto https://app.local/orders            # первая команда сама поднимает сессию (headless)
sbox-browser snapshot                                 # дерево элементов со ссылками [eN]
sbox-browser click e7                                 # действия по ссылкам или селекторам: css, text=, aria=, xpath=
sbox-browser fill e3 "кофе" && sbox-browser press Enter
sbox-browser wait --text "Найдено" && sbox-browser text
sbox-browser console --errors && sbox-browser requests # ошибки консоли, ответы 4xx/5xx и неудачные запросы
sbox-browser screenshot                               # PNG в ~/.sbox/browser/shots, путь печатается
sbox-browser state save auth.json                     # перенести вход в CI: там sbox-browser state load auth.json
sbox-browser stop
```

Существующий браузер вместо установки: флаг `--executable`, переменная `SBOX_BROWSER_EXECUTABLE` или `browser.executable` в `.sbox/config.yaml`; без них по порядку проверяются кэш инструмента, кэш puppeteer, системный Chrome, Chromium, Edge и Brave. Сессия это фоновый процесс с браузером: команды идут к нему через локальный сокет, поэтому страница, куки, консоль и сетевые ошибки сохраняются между вызовами; `--session <имя>` даёт несколько независимых браузеров, простой 30 минут завершает сессию. Настройки в секции `browser` конфига: `executable`, `headless`, `profile`, `baseUrl`, `cacheDir`, `viewport`, `timeoutMs`, `idleMinutes`; те же значения задаются переменными `SBOX_BROWSER_EXECUTABLE`, `SBOX_BROWSER_HEADLESS`, `SBOX_BROWSER_PROFILE`, `SBOX_BROWSER_BASE_URL`, `SBOX_BROWSER_CACHE_DIR` (каталог инструмента: `SBOX_BROWSER_HOME`) и глобальными флагами `--profile`, `--session`, `--timeout`, `--cwd`. Все команды поддерживают `--json`, ошибки разбора аргументов тоже приходят в JSON-конверте. Профили и файлы состояния содержат секреты входа и живут в `~/.sbox/browser`, вне репозитория. Скилл `sbox-browser` лежит в `assets/skills` и копируется в папку хоста командой `sbox host install --target claude | codex`; агентам researcher, tester и verifier он подключается по `metadata.roles` (в Claude Code полем `skills`).

## Контракт поведения продукта

Отдельный `sbox-contract` работает со спецификациями spec-box и OpenSpec без запуска процесса SDD. В существующем проекте используется секция `spec` из `.sbox/config.yaml`, отдельно — `.sbox-contract.yaml` или автоопределение по `.tms.json` / `openspec/specs`. `--cwd` задаёт каталог, `--format` — явный выбор формата.

```bash
sbox-contract init --format spec-box       # новый самостоятельный проект
sbox-contract index --json
sbox-contract search "повторная отправка заказа" --json
sbox-contract show orders --json
sbox-contract delta init ./changes/add-export
# записать файлы дельты по инструкции в созданном README
sbox-contract diff --delta ./changes/add-export --preview --json
sbox-contract validate --delta ./changes/add-export --json
sbox-contract apply --delta ./changes/add-export --check --json
sbox-contract apply --delta ./changes/add-export --if-match <revision>
```

Поиск возвращает отдельные требования и сценарии с источниками. Предпросмотр показывает будущее состояние без записи. Для применения нужна `revision` из проверки: изменение истины или дельты после проверки вызывает конфликт. При ошибке применения файлы восстанавливаются. Самостоятельное применение не архивирует задачу, не коммитит и не создаёт PR.

**Группа `sbox spec` удалена:** `list` заменён на `sbox-contract index`, `show` — на `sbox-contract show`, `diff --change <id>` — на `sbox-contract diff --delta <папка-изменения>/specs`. Обновите скиллы проектов командой `sbox host install --target claude` или `--target codex`. `sbox archive` и `sbox deliver` продолжают применять дельты через общий модуль; в процессе SDD роли используют только чтение и подготовку дельт.

## Wiki для агентов

`sbox-wiki` работает с `.sbox/wiki/` (или `project.wiki` из конфига). Для произвольной папки без SDD укажите `--dir ./knowledge`; без конфига и этого флага используется `wiki/`. `--cwd` задаёт каталог проекта.

```bash
sbox-wiki index --json
sbox-wiki search "добавить экспорт" --path src/export --limit 5 --json
sbox-wiki get exports --json
sbox-wiki get exports --section добавление-формата
sbox-wiki backlinks exports --json
sbox-wiki put exports --file /tmp/exports.md --if-match <revision> --json
sbox-wiki put new-topic.md --file /tmp/new-topic.md --create --json
sbox-wiki validate --json
```

Индекс содержит краткое содержание, ситуации применения и заголовки, без текста страниц. Поиск возвращает причины совпадения и фрагменты; это лексический поиск по тексту и метаданным с повышением веса страниц подходящей области кода. `summary` и `read_when` заполняет автор или агент. Страницы — обычный Markdown, кеш хранится вне репозитория во временной папке и обновляется для изменённых файлов; `index --rebuild` пересобирает его.

`get --json` возвращает полное содержимое с фронтматтером и `revision` для последующей записи. `put` отклоняет устаревшую ревизию и ошибки целостности wiki, в том числе удаление раздела, на который ссылается другая страница. `--file -` читает stdin. Для согласованной правки нескольких связанных страниц можно использовать редактор и затем `validate`.

Валидация проверяет типы метаданных, уникальность id, локальные ссылки и якоря заголовков; ссылки из блоков кода не учитываются. Внешние URL не проверяются, ссылки за пределы wiki запрещены; HTML-ссылки и пользовательские HTML-якоря не поддерживаются. Код выхода 1 означает ошибку; отсутствие summary/read_when — предупреждение. Скилл `sbox-wiki` устанавливается для Claude и Codex через `sbox host install`; `sbox doctor` использует ту же проверку wiki.

Аудит плана обязателен: `plan → [гейт plan] → challenge → cover`. Challenger проверяет артефакты против запроса и кода, ищет пропущенные сценарии и возвращает блокирующие замечания планировщику. После исправления повторяются гейт и аудит; отчёты сохраняются в `evidence/challenge-N.md`. Человеческие гейты зависят от автономности, аудит — нет. Изменения, уже прошедшие планирование до обновления, продолжаются с текущей фазы; при возврате в plan проходят новый аудит.

## Состояние

Готово (этапы 1 и 2): конфиг и раскладка `.sbox/`, жизненный цикл изменения с гейтами, возвратами и бюджетом (`parked`), ревизия и lock `change.yaml`, пакеты и receipt запусков, приём отчётов с проверками (артефакты, дельты, задачи, защищённые тесты, дрейф change-set, disposition и `delivery_narrative` ревьюера), запечатывание change-set после реализации, адаптер spec-box, категории документации и структурный `doctor`, материалы для Claude Code, адаптеры сред Claude и Codex с надзором и одним транспортным повтором, `run`/`stop`/`watch`, адаптер GitHub с идемпотентной доставкой и каналом гейтов через комментарии, отчёты тестов jest/vitest/playwright и покрытие, шаблоны CI и Dockerfile.

Готово также: адаптер OpenSpec (истина в `openspec/specs`, дельты в родном синтаксисе ADDED/MODIFIED/REMOVED/RENAMED, текстовое применение с сохранением остальных разделов, `.openspec.yaml` в папке изменения для совместимости с CLI OpenSpec).

Готово также: wiki проекта в `.sbox/wiki/` (индекс страниц с `read_when` попадает в пакет каждой роли), метрики `sbox metrics` и оценка `sbox change rate`.

Готово также: папка `runs/` не переносится в архив (ответы ролей и квитанции остаются в истории ветки, `delivery_narrative` и запуски в `change.yaml`; `archive.runs: true` сохраняет её), `sbox-browser` для проверки интерфейса (сессии с Chrome через `puppeteer-core`, необязательная установка браузера, вход человеком с постоянным профилем, снимок дерева доступности для агентов, перенос состояния входа), проверка браузера в `sbox doctor`.

Не готово: дискавери и правила (этап 3), Arcadia (этап 4), межрепозиторный протокол (этап 5), роутер и дистилляция wiki (этап 6), семантический `doctor --deep`.

Для Codex в существующем проекте:

```bash
sbox host install --target codex
sbox models --runner codex
```

В новой сессии вызовите `$sbox-run`. Headless-раннер сохраняет ID сессии и продолжает её при возврате к той же роли с теми же настройками; старые клиенты без нужных возможностей resume запускают новую сессию. При первоначальной настройке доступен `sbox init --host codex`. Агент возвращает полный отчёт оркестратору; тот сохраняет его и передаёт CLI. Headless-вариант без интерактивного клиента: `sbox run --runner codex --change <id>`.
