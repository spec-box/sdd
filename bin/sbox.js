#!/usr/bin/env node
import('../dist/cli/main.js').then((m) => m.main(process.argv)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
