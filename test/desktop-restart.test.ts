import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { DesktopRestarter, powerShellRestartRunner, type DesktopRestartRunner } from '../src/connector/desktop-restart.js';

const stateRoots: string[] = [];
after(async () => {
  for (const root of stateRoots) await rm(root, { recursive: true, force: true });
});

function setup(platform: NodeJS.Platform = 'win32') {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'codex-desktop-restart-state-')));
  stateRoots.push(stateRoot);
  const stateDirectory = join(stateRoot, 'desktop-restarts');
  let now = Date.now();
  const checks: string[] = [];
  const launches: Array<{ script: string; resultPath: string; id: string }> = [];
  let response = '{"supported":true}';
  let launchError: Error | null = null;
  let launchHandler: ((resultPath: string, id: string) => Promise<void>) | null = null;
  const runner: DesktopRestartRunner = {
    async check(script) { checks.push(script); return response; },
    async launch(script, resultPath, id) {
      launches.push({ script, resultPath, id });
      if (launchError) throw launchError;
      await launchHandler?.(resultPath, id);
    },
  };
  return {
    restarter: new DesktopRestarter({ platform, runner, stateDirectory, now: () => now }),
    checks, launches, stateDirectory, runner, now: () => now,
    respond(value: string) { response = value; },
    failLaunch(error: Error) { launchError = error; },
    onLaunch(handler: (resultPath: string, id: string) => Promise<void>) { launchHandler = handler; },
    advance(ms: number) { now += ms; },
  };
}

test('unsupported operating systems never launch or probe a restart helper', async () => {
  const { restarter, checks, launches } = setup('linux');
  assert.equal(await restarter.isSupported(), false);
  await assert.rejects(restarter.restart(), { message: 'desktop_restart_unavailable' });
  assert.deepEqual(checks, []);
  assert.deepEqual(launches, []);
});

test('restart checks capability again and does not launch after capability was lost', async () => {
  const state = setup();
  assert.equal(await state.restarter.isSupported(), true);
  state.respond('{"supported":false}');
  await assert.rejects(state.restarter.restart(), { message: 'desktop_restart_unavailable' });
  assert.equal(state.checks.length, 2);
  assert.deepEqual(state.launches, []);
});

test('invalid or unexpected helper output fails closed', async () => {
  const state = setup();
  for (const output of ['true', 'null', '{}', '{"supported":"true"}',
    '{"supported":true,"privatePath":"redacted"}', 'warning\n{"supported":true}']) {
    state.respond(output);
    assert.equal(await state.restarter.isSupported(), false);
  }
  assert.deepEqual(state.launches, []);
});

test('successful restart submits the same absolute project helper resolved from source or build', async () => {
  const state = setup();
  const job = await state.restarter.restart();
  assert.equal(state.checks.length, 1);
  assert.deepEqual(state.launches.map(call => call.script), state.checks);
  assert.equal(isAbsolute(state.launches[0].script), true);
  assert.equal(normalize(state.launches[0].script).endsWith(normalize('scripts/restart-codex-desktop.ps1')), true);
  assert.equal(normalize(state.launches[0].script).includes(normalize('src/scripts/')), false);
  assert.equal(normalize(state.launches[0].script).includes(normalize('build/scripts/')), false);
  assert.equal(job.status, 'pending');
  assert.equal(state.launches[0].id, job.id);
  assert.equal(basename(state.launches[0].resultPath), `${job.id}.json`);
});

test('launch failures do not expose local paths or runner diagnostics', async () => {
  const state = setup();
  state.failLaunch(new Error('C:\\Users\\private-user\\secret-data'));
  await assert.rejects(state.restarter.restart(), { message: 'desktop_restart_failed' });
});

test('probe failures fail closed without exposing diagnostics', async () => {
  const state = setup();
  const restarter = new DesktopRestarter({ platform: 'win32', stateDirectory: state.stateDirectory, runner: {
    async check() { throw new Error('private host diagnostic'); },
    async launch() { throw new Error('must not launch'); },
  } });
  assert.equal(await restarter.isSupported(), false);
  await assert.rejects(restarter.restart(), { message: 'desktop_restart_unavailable' });
});

test('restart status validates identifiers before reading a document', async () => {
  const state = setup();
  for (const id of ['../latest', 'not-a-uuid', `${randomUUID()}/../latest`, randomUUID().toUpperCase()]) {
    await assert.rejects(state.restarter.status(id), { message: 'desktop_restart_invalid_id' });
  }
  assert.equal(await state.restarter.status(), null);
  assert.deepEqual(state.launches, []);
});

test('pending restart requests share one persisted operation', async () => {
  const state = setup();
  const [first, concurrent] = await Promise.all([state.restarter.restart(), state.restarter.restart()]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(await state.restarter.restart(), first);
  assert.equal(state.launches.length, 1);
  assert.equal(state.checks.length, 1);
});

test('restart completion persists across connector instances', async () => {
  const state = setup();
  state.onLaunch(async (resultPath, id) => {
    await writeFile(resultPath, JSON.stringify({ id, status: 'completed', startedAt: state.now(), finishedAt: state.now() + 1 }));
  });
  const completed = await state.restarter.restart();
  assert.equal(completed.status, 'completed');
  const restored = new DesktopRestarter({ platform: 'win32', stateDirectory: state.stateDirectory,
    runner: state.runner, now: state.now });
  assert.deepEqual(await restored.status(), completed);
  assert.deepEqual(await restored.status(completed.id), completed);
  assert.equal(state.launches.length, 1);
});

test('failed operation details survive restart and unknown diagnostics are redacted', async () => {
  const state = setup();
  const job = await state.restarter.restart();
  const failed = { ...job, status: 'failed', error: 'desktop_restart_stop_failed', finishedAt: state.now() };
  await writeFile(state.launches[0].resultPath, JSON.stringify(failed));
  const restored = new DesktopRestarter({ platform: 'win32', stateDirectory: state.stateDirectory,
    runner: state.runner, now: state.now });
  assert.deepEqual(await restored.status(), failed);
  await writeFile(state.launches[0].resultPath, JSON.stringify({ ...failed, error: 'private-user-secret-path' }));
  assert.equal((await restored.status())?.error, 'desktop_restart_helper_failed');
});

test('missing or stale helper results never report completion', async () => {
  const state = setup();
  const pending = await state.restarter.restart();
  state.advance(90_001);
  assert.equal((await state.restarter.status(pending.id))?.status, 'unknown');
  assert.equal((await state.restarter.status(pending.id))?.error, 'desktop_restart_status_timeout');
  assert.equal((await state.restarter.status(randomUUID()))?.status, 'unknown');
});

test('Windows read-only preflight rejects escaped paths and unrelated or ambiguous processes', {
  skip: process.platform !== 'win32',
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'codex-desktop-restart-')));
  const packageRoot = join(fixture, 'package');
  const executable = join(packageRoot, 'app', 'ChatGPT.exe');
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const processRow = (id: number, parent: number, path = executable) =>
    `[pscustomobject]@{ProcessId=${id};ParentProcessId=${parent};ExecutablePath=${quote(path)};CreationDate=[datetime]'2026-01-01'}`;
  try {
    await mkdir(join(packageRoot, 'app'), { recursive: true });
    await writeFile(executable, '');
    await writeFile(join(fixture, 'outside.exe'), '');
    const cases = [
      { relative: 'app/ChatGPT.exe', rows: [processRow(10, 1), processRow(11, 10)], supported: true },
      { relative: '../outside.exe', rows: [processRow(10, 1, join(fixture, 'outside.exe'))], supported: false },
      { relative: 'app/ChatGPT.exe', rows: [processRow(10, 1, join(fixture, 'ChatGPT.exe'))], supported: false },
      { relative: 'app/ChatGPT.exe', rows: [processRow(10, 1), processRow(20, 1)], supported: false },
    ];
    for (const scenario of cases) {
      const harness = `
function Get-AppxPackage { param($Name)
  [pscustomobject]@{PackageFullName='fixture';InstallLocation=${quote(packageRoot)};PackageFamilyName='OpenAI.Codex_fixture'}
}
function Get-AppxPackageManifest { param($Package)
  [xml]'<Package><Applications><Application Id="App" Executable="${scenario.relative}" /></Applications></Package>'
}
function Get-CimInstance { param($ClassName, $Property, $Filter)
  @(${scenario.rows.join(',')})
}
function Stop-Process { throw 'preflight_must_not_stop_processes' }
function Start-Process { throw 'preflight_must_not_start_processes' }
function Start-Sleep { throw 'preflight_must_not_schedule_restart' }
& ${quote(resolve('scripts/restart-codex-desktop.ps1'))} -CheckOnly
`;
      const { stdout, stderr } = await promisify(execFile)('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness,
      ], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(stdout), { supported: scenario.supported });
      assert.equal(stderr, '');
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('production Windows launcher executes a harmless PowerShell job body', {
  skip: process.platform !== 'win32',
}, async () => {
  const state = setup();
  await mkdir(state.stateDirectory, { recursive: true });
  const id = randomUUID();
  const resultPath = join(state.stateDirectory, `${id}.json`);
  const helperPath = join(state.stateDirectory, 'harmless-helper.ps1');
  await writeFile(resultPath, JSON.stringify({ id, status: 'pending', startedAt: state.now() }));
  await writeFile(helperPath, `param([string]$OperationId, [string]$ResultPath)
$snapshot = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
if ($snapshot.id -cne $OperationId) { exit 1 }
$result = @{id=$OperationId;status='completed';startedAt=$snapshot.startedAt;finishedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
[IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
`);
  await powerShellRestartRunner.launch(helperPath, resultPath, id);
  for (let attempt = 0; attempt < 100; attempt++) {
    const document = JSON.parse(await readFile(resultPath, 'utf8'));
    if (document.status === 'completed') {
      assert.equal(document.id, id);
      return;
    }
    if (document.status === 'failed') assert.fail(`harmless helper failed: ${document.error}`);
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail('PowerShell launched but did not execute the harmless helper body');
});

test('Windows complete restart branch persists verified outcomes using only mocked process actions', {
  skip: process.platform !== 'win32',
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'codex-desktop-restart-branch-')));
  const packageRoot = join(fixture, 'package');
  const executable = join(packageRoot, 'app', 'ChatGPT.exe');
  const resultDirectory = join(fixture, 'desktop-restarts');
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const cases = [
    { scenario: 'completed', status: 'completed', error: undefined },
    { scenario: 'stop-denied', status: 'failed', error: 'desktop_restart_stop_failed' },
    { scenario: 'stop-timeout', status: 'failed', error: 'desktop_restart_stop_timeout' },
    { scenario: 'activation-failed', status: 'failed', error: 'desktop_restart_activation_failed' },
    { scenario: 'activation-timeout', status: 'failed', error: 'desktop_restart_activation_timeout' },
    { scenario: 'identity-changed', status: 'failed', error: 'desktop_restart_identity_changed' },
    { scenario: 'invalid-job', status: 'pending', error: undefined },
  ];
  try {
    await mkdir(join(packageRoot, 'app'), { recursive: true });
    await mkdir(resultDirectory);
    await writeFile(executable, '');
    for (const scenario of cases) {
      const id = randomUUID();
      const resultPath = join(resultDirectory, `${id}.json`);
      const startedAt = Date.now();
      const pending = { id: scenario.scenario === 'invalid-job' ? randomUUID() : id, status: 'pending', startedAt };
      await writeFile(resultPath, JSON.stringify(pending));
      const harness = `
$global:fixtureScenario = ${quote(scenario.scenario)}
$global:fixtureExecutable = ${quote(executable)}
$global:fixtureResultPath = ${quote(resultPath)}
$global:fixtureRows = @(
  [pscustomobject]@{ProcessId=10;ParentProcessId=1;ExecutablePath=$global:fixtureExecutable;CreationDate=[datetime]'2026-01-01'},
  [pscustomobject]@{ProcessId=11;ParentProcessId=10;ExecutablePath=$global:fixtureExecutable;CreationDate=[datetime]'2026-01-01'},
  [pscustomobject]@{ProcessId=12;ParentProcessId=10;ExecutablePath='C:/unrelated/codex.exe';CreationDate=[datetime]'2026-01-01'},
  [pscustomobject]@{ProcessId=13;ParentProcessId=1;ExecutablePath='C:/unrelated/ChatGPT.exe';CreationDate=[datetime]'2026-01-01'}
)
function Get-AppxPackage { param($Name)
  [pscustomobject]@{PackageFullName='fixture';InstallLocation=${quote(packageRoot)};PackageFamilyName='OpenAI.Codex_fixture'}
}
function Get-AppxPackageManifest { param($Package)
  [xml]'<Package><Applications><Application Id="App" Executable="app/ChatGPT.exe" /></Applications></Package>'
}
function Get-CimInstance { param($ClassName, $Property, $Filter)
  $rows = $global:fixtureRows
  if ($Filter) {
    $requestedId = [uint32]($Filter -replace '^ProcessId = ', '')
    $rows = @($rows | Where-Object { $_.ProcessId -eq $requestedId })
  }
  $rows | ForEach-Object {
    [pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;ExecutablePath=$_.ExecutablePath;CreationDate=$_.CreationDate}
  }
}
function Start-Sleep { [CmdletBinding()] param($Seconds, $Milliseconds)
  if ($Seconds -eq 2) {
    $snapshot = Get-Content -LiteralPath $global:fixtureResultPath -Raw | ConvertFrom-Json
    if ($snapshot.status -ne 'restarting') { throw 'fixture_missing_restarting_status' }
    [Console]::Out.WriteLine('restarting')
    if ($global:fixtureScenario -eq 'identity-changed') { $global:fixtureRows[0].CreationDate = [datetime]'2026-01-02' }
  }
}
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force)
  [Console]::Out.WriteLine('stop:' + $Id)
  if ($global:fixtureScenario -eq 'stop-denied') { throw 'fixture_private_stop_diagnostic' }
  if ($global:fixtureScenario -ne 'stop-timeout') {
    $global:fixtureRows = @($global:fixtureRows | Where-Object { $_.ProcessId -ne $Id })
  }
}
function Wait-Process { [CmdletBinding()] param($Id, $Timeout)
  [Console]::Out.WriteLine('wait')
}
function Start-Process { [CmdletBinding()] param($FilePath, $ArgumentList, $WindowStyle)
  if ($WindowStyle -ne 'Hidden' -or $ArgumentList -cne 'shell:AppsFolder\\OpenAI.Codex_fixture!App') {
    throw 'fixture_invalid_activation'
  }
  [Console]::Out.WriteLine('activate')
  if ($global:fixtureScenario -eq 'activation-failed') { throw 'fixture_private_activation_diagnostic' }
  if ($global:fixtureScenario -ne 'activation-timeout') {
    $global:fixtureRows = @([pscustomobject]@{ProcessId=20;ParentProcessId=1;ExecutablePath=$global:fixtureExecutable;CreationDate=[datetime]'2026-01-02'})
  }
}
& ${quote(resolve('scripts/restart-codex-desktop.ps1'))} -OperationId ${quote(id)} -ResultPath ${quote(resultPath)}
`;
      let output: { stdout: string; stderr: string };
      let exitCode = 0;
      try {
        output = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness], {
          windowsHide: true, timeout: 15_000, encoding: 'utf8',
        });
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        if (typeof failure.stdout !== 'string' || typeof failure.stderr !== 'string') throw error;
        output = failure;
        exitCode = failure.code;
      }
      const snapshot = JSON.parse(await readFile(resultPath, 'utf8'));
      assert.equal(snapshot.status, scenario.status, `${scenario.scenario}: ${snapshot.error || ''}; ${output.stdout}; ${output.stderr}`);
      assert.equal(snapshot.error, scenario.error, scenario.scenario);
      assert.equal(snapshot.startedAt, startedAt);
      if (scenario.scenario === 'completed') {
        assert.equal(exitCode, 0);
        assert.ok(snapshot.finishedAt >= startedAt);
        assert.deepEqual(output.stdout.trim().split(/\r?\n/), ['restarting', 'stop:10', 'stop:11', 'wait', 'activate']);
      } else {
        assert.equal(exitCode, 1, scenario.scenario);
      }
      if (scenario.scenario === 'identity-changed' || scenario.scenario === 'invalid-job') {
        assert.equal(output.stdout.includes('stop:'), false);
        assert.equal(output.stdout.includes('activate'), false);
      }
      if (scenario.scenario === 'stop-denied' || scenario.scenario === 'stop-timeout') {
        assert.equal(output.stdout.includes('activate'), false);
      }
      assert.equal(JSON.stringify(snapshot).includes(fixture), false);
      assert.equal(JSON.stringify(snapshot).includes('fixture_private'), false);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
