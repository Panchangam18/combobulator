import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PATHS, LAUNCHD_LABEL } from '../config.js';
import { resetEpoch } from '../state.js';
import { info, warn } from '../log.js';
import { fixCodexProjects } from './fix-codex-projects.js';

function findEntrypoint() {
  // bin/combobulator.js relative to this file (src/commands/install.js -> ../../bin/combobulator.js)
  return path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'combobulator.js');
}

function plistXml({ nodeBin, scriptPath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${scriptPath}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export async function install() {
  fs.mkdirSync(PATHS.combobulateDir, { recursive: true });
  fs.mkdirSync(PATHS.combobulateSynced, { recursive: true });
  fs.mkdirSync(path.dirname(PATHS.launchdPlist), { recursive: true });

  const nodeBin = process.execPath;
  const scriptPath = findEntrypoint();

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cannot find CLI entrypoint at ${scriptPath}`);
  }

  // Reset the "epoch" — sessions from before install are considered pre-existing.
  // Daemon only mirrors sessions newer than this.
  resetEpoch();

  const xml = plistXml({ nodeBin, scriptPath, logPath: PATHS.combobulateLog });
  fs.writeFileSync(PATHS.launchdPlist, xml);
  info(`wrote launchd plist at ${PATHS.launchdPlist}`);

  // Reload via launchctl. We unload first (ignore failure if not loaded), then load.
  if (fs.existsSync(PATHS.legacyLaunchdPlist)) {
    try {
      execFileSync('launchctl', ['unload', PATHS.legacyLaunchdPlist], { stdio: 'ignore' });
    } catch {}
    fs.unlinkSync(PATHS.legacyLaunchdPlist);
  }
  try {
    execFileSync('launchctl', ['unload', PATHS.launchdPlist], { stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('launchctl', ['load', PATHS.launchdPlist], { stdio: 'inherit' });
    info('launchd agent loaded — daemon will start now and on every login.');
  } catch (e) {
    warn(`launchctl load failed: ${e.message}`);
    warn('You can run the daemon manually with: combobulator daemon');
  }

  // Backfill any pre-existing mirrors into Codex Desktop's workspace registry,
  // so a fresh install on top of prior state immediately shows up.
  try {
    await fixCodexProjects();
  } catch (e) {
    warn(`fix-codex-projects failed: ${e.message}`);
  }

  info('install complete.');
  info(`  state:  ${PATHS.combobulateState}`);
  info(`  log:    ${PATHS.combobulateLog}`);
  info(`  synced: ${PATHS.combobulateSynced}`);
}
