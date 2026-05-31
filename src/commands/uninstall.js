import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PATHS } from '../config.js';
import { info } from '../log.js';

export async function uninstall() {
  if (fs.existsSync(PATHS.launchdPlist)) {
    try {
      execFileSync('launchctl', ['unload', PATHS.launchdPlist], { stdio: 'ignore' });
    } catch {}
    fs.unlinkSync(PATHS.launchdPlist);
    info(`removed launchd plist at ${PATHS.launchdPlist}`);
  } else {
    info('no launchd plist to remove.');
  }
  info('uninstall complete. State at ~/.combobulate is preserved — delete it manually if you want a clean slate.');
}
