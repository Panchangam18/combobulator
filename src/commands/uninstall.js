import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PATHS } from '../config.js';
import { info } from '../log.js';

export async function stop() {
  for (const plist of [PATHS.launchdPlist, PATHS.legacyLaunchdPlist]) {
    if (!fs.existsSync(plist)) continue;
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch {}
    fs.unlinkSync(plist);
    info(`removed launchd plist at ${plist}`);
  }
  info('stopped. State at ~/.combobulator is preserved; use discombobulate --all to remove mirrored chats.');
}
