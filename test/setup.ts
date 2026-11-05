import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No test may touch the real ~/.tutordesk.
process.env.TUTORDESK_HOME = mkdtempSync(path.join(os.tmpdir(), 'td2-tutordesk-home-'));
