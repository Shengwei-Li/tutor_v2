// Stands in for `claude`: records each call's arguments, one JSON line per call.
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
