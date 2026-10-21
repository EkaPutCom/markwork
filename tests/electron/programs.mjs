// Home's Set up section and the Programs page, in the real window: with pi missing Home says so and the sidebar's
// Programs is marked; Hide keeps the section away; the page shows each program; pi installed meanwhile is found by Check
// again.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { scratchFolder, launchApp, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('programs');
writeFileSync(join(notes, 'note.md'), '# Note\n');
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
mkdirSync(home);
mkdirSync(bin);
mkdirSync(join(scratch, 'config', 'markwork-electron'), { recursive: true });
writeFileSync(join(scratch, 'config', 'markwork-electron', 'settings.json'), JSON.stringify({ welcomed: true }));
const windows = process.platform === 'win32';
const git = execFileSync(windows ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
// A pi that only says its version, put where the app looks once it is "installed".
const installPi = () => {
    if (windows) writeFileSync(join(bin, 'pi.cmd'), '@echo 1.0.3\r\n');
    else { writeFileSync(join(bin, 'pi'), '#!/bin/sh\necho 1.0.3\n'); chmodSync(join(bin, 'pi'), 0o755); }
};

// Each step is printed as it ends, and a file that hangs ends itself, so the log says where.
const { steps, step } = stepper({ echo: true });
setTimeout(() => { console.log('  ✗ the Programs test did not end within 2 minutes'); process.exit(1); }, 120_000).unref();
// On Linux the app gets a PATH with git and the system's folders, and a home folder of its own (the lookup also tries
// ~/.local/bin). macOS and Windows keep their environment: with another home Electron does not start on Windows, and on
// macOS the keychain behind safeStorage waits for a dialog no one answers. There only the folders that hold a pi leave
// the PATH (Windows spells the variable Path; the same name is replaced, so the app does not get two).
const hasPi = dir => ['pi', 'pi.cmd', 'pi.exe', 'pi.bat'].some(name => existsSync(join(dir, name)));
const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
const env = process.platform === 'linux'
    ? { HOME: home, PATH: [bin, dirname(git), '/usr/bin', '/bin'].join(delimiter) }
    : { [pathKey]: [bin, ...(process.env[pathKey] ?? '').split(delimiter).filter(dir => dir && !hasPi(dir))].join(delimiter) };
const app = await launchApp({ scratch, notes, env });
let failed = false;
try {
    const page = await app.firstWindow();
    const setup = page.getByRole('region', { name: 'Set up' });

    await step('Home lists pi as not installed, and the sidebar marks Programs', async () => {
        await page.getByRole('button', { name: 'Home', exact: true }).first().click();
        await setup.waitFor({ timeout: 15000 });
        await setup.getByText('pi is not installed').waitFor();
        assert.equal(await setup.getByText('git is not installed').count(), 0, 'git was found');
        await page.getByRole('button', { name: /^Programs.*missing/ }).first().waitFor();
    });

    await step('Hide takes the section away; the sidebar keeps its mark', async () => {
        await setup.getByRole('button', { name: 'Hide' }).click();
        await setup.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: /^Programs.*missing/ }).first().waitFor();
    });

    await step('the sidebar opens the page: git installed with its path, pi with how to install it, markworkd optional', async () => {
        await page.getByRole('button', { name: /^Programs/ }).first().click();
        await page.getByRole('heading', { name: 'Programs', level: 1 }).waitFor();
        const gitCard = page.getByRole('region', { name: 'git: Installed' });
        await gitCard.getByText('git version').waitFor({ timeout: 15000 });
        const pi = page.getByRole('region', { name: 'pi: Not installed' });
        await pi.getByRole('tab', { name: windows ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', selected: true }).waitFor();
        await pi.getByText('npm install -g @earendil-works/pi-coding-agent').waitFor();
        await pi.getByRole('button', { name: 'Open Terminal' }).waitFor();
        const markworkd = page.getByRole('region', { name: 'markworkd: Not installed' });
        await markworkd.getByText('Optional').waitFor();
        await markworkd.getByRole('button', { name: 'How to install' }).click();
        await markworkd.getByText(/go install/).waitFor();
    });

    await step('pi installed meanwhile: Check again finds it, and the mark goes', async () => {
        installPi();
        await page.getByRole('button', { name: 'Check again' }).click();
        await page.getByRole('region', { name: 'pi: Installed' }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: 'Programs', exact: true }).first().waitFor();
    });

    await step('Home has no Set up section once nothing needed is missing', async () => {
        await page.getByRole('button', { name: 'Home', exact: true }).first().click();
        await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor();
        assert.equal(await setup.count(), 0);
    });
} catch {
    failed = true;
} finally {
    await app.close();
}
console.log(`Programs: ${steps.length} steps`);
if (failed) process.exit(1);
