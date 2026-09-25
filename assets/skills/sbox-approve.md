---
name: sbox-approve
description: Утвердить или отклонить гейт изменения @spec-box/sdd (proposal, plan, tests). Используй, когда пользователь говорит «утверждаю», «одобряю план», «отклоняю с замечанием».
---

# sbox-approve

1. Определи изменение и гейт: `sbox status --change <id> --json` показывает ожидающий гейт.
2. Утверждение: `sbox approve <gate> --change <id> --by <user> [--comment "..."] [--answer Q1=B]`.
3. Отклонение: `sbox reject <gate> --change <id> --by <user> --comment "<замечание>"`.
4. Покажи результат и предложи продолжить скиллом sbox-run.
