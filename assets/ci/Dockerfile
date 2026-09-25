# Образ для headless-запуска @spec-box/sdd в нейтральной среде (docs/design.md, раздел 13).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm @spec-box/sdd
# Codex CLI ставится отдельно, если нужен адаптер codex: npm install -g @openai/codex
# Проверка интерфейса верификатором: RUN sbox-browser install --browser chrome-headless-shell
# (в Debian/Ubuntu Chrome требует системные библиотеки: libnss3, libatk-bridge2.0-0, libgbm1, libasound2 и другие)
WORKDIR /work
ENV SBOX_HOME=/work/.sbox-runs
ENTRYPOINT ["sbox"]
CMD ["--help"]
