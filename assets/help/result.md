---
description: Блок sbox-result в ответе роли — статусы, блокеры и поля по ролям
---

# Блок sbox-result

Ответ роли заканчивается YAML-блоком с первой строкой `# sbox-result`. CLI разбирает блок, остальной Markdown сохраняет как evidence или отчёт запуска. Ответ без блока считается неуспешным запуском.

```yaml
# sbox-result
status: готово | утверждение | заблокировано
blocker: { category: артефакт | тесты | реализация | внешний | пользователь | нет, artifact: <id артефакта>, message: "" }
```

- `status: заблокировано` требует категорию блокера, отличную от «нет», и точное сообщение; категория «артефакт» требует `artifact` (specs, design, tasks…).
- `status: утверждение` возвращает только planner на фазе propose: изменение уходит на гейт proposal.

## Поля по ролям

- **researcher**: `request` — разбор запроса, по строке на явное утверждение: `{ quote: "дословная цитата", status: подтверждено | противоречит | не проверено, evidence: "путь и факт" }`. CLI сверяет цитаты с текстом запроса; без поля отчёт не принимается.
- **planner, фаза propose**: `size: small | normal | large`; `complexity: { implementation, review }` со значениями простая | обычная | высокая; `skip_specs: true`, если поведение не меняется; `deviations: [{ subject: запрос | evidence, text, decision, reason }]` — отступления proposal от запроса или evidence, обязательны при противоречиях исследователя.
- **planner, фаза plan**: `questions: [{ id: Q1, priority: P0 | P1 | P2, text }]`; вопрос P0 останавливает изменение до ответа человека.
- **tester**: `protected` — глобы созданных и изменённых тестовых файлов, они становятся защищёнными от реализатора; `verified` — выполненные проверки одной строкой каждая.
- **implementer**: `verified`.
- **verifier**: `checks: [{ id: V1, purpose, result: PASS | FAIL | PARTIAL | NOT_RUN, evidence }]`, `gaps: [{ id: G1, environment, oracle, risk }]`, `verified`. Хотя бы один FAIL означает статус «заблокировано».
- **reviewer**: `findings: [{ level: blocking | non-blocking, file, text }]`; в фазе review `dispositions: [{ item, disposition: satisfied | manual_gap_accepted | change_required | blocked, reason }]` по каждому не-PASS пункту и пробелу верификатора, а при статусе «готово» `delivery_narrative: { title, delta, why, preserved, rollout, rollback }` — единственный источник текста пул-реквеста.

Полный контракт и машина состояний: docs/design.md, раздел 5.
