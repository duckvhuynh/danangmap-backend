import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pinnedFrontendSha = '2de5b29bc2e1fc7f2bbac641cdf5eda0e8bc5d5f';
const frontendContext = resolve(process.env.DANANGMAP_FRONTEND_CONTEXT ?? '../danangmap-frontend');
const frontendSha = git(['-C', frontendContext, 'rev-parse', 'HEAD']).trim();
const expectedSha = process.env.DANANGMAP_FRONTEND_SHA?.trim();
const backendSha = git(['rev-parse', 'HEAD']).trim();
const expectedBackendSha = process.env.DANANGMAP_BACKEND_SHA?.trim();
if (!/^[a-f0-9]{40}$/.test(frontendSha)) {
  throw new Error('Frontend worktree did not resolve to a full Git commit SHA');
}
if (!/^[a-f0-9]{40}$/.test(backendSha)) {
  throw new Error('Backend worktree did not resolve to a full Git commit SHA');
}
if (!expectedSha) {
  throw new Error('DANANGMAP_FRONTEND_SHA is required');
}
if (!expectedBackendSha) {
  throw new Error('DANANGMAP_BACKEND_SHA is required');
}
if (expectedSha && !/^[a-f0-9]{40}$/.test(expectedSha)) {
  throw new Error('DANANGMAP_FRONTEND_SHA must be a full lowercase Git commit SHA');
}
if (expectedBackendSha && !/^[a-f0-9]{40}$/.test(expectedBackendSha)) {
  throw new Error('DANANGMAP_BACKEND_SHA must be a full lowercase Git commit SHA');
}
if (expectedSha && frontendSha !== expectedSha) {
  throw new Error(`Frontend SHA mismatch: expected ${expectedSha}, found ${frontendSha}`);
}
if (frontendSha !== pinnedFrontendSha) {
  throw new Error(`Frontend SHA mismatch: harness pins ${pinnedFrontendSha}, found ${frontendSha}`);
}
if (expectedBackendSha && backendSha !== expectedBackendSha) {
  throw new Error(`Backend SHA mismatch: expected ${expectedBackendSha}, found ${backendSha}`);
}
const dirty = git(['-C', frontendContext, 'status', '--porcelain']).trim();
if (dirty && process.env.DANANGMAP_ALLOW_DIRTY_FRONTEND !== 'true') {
  throw new Error(
    'Frontend worktree is dirty; commit it or set DANANGMAP_ALLOW_DIRTY_FRONTEND=true for local-only diagnostics.',
  );
}
const backendDirty = git(['status', '--porcelain']).trim();
if (backendDirty && process.env.DANANGMAP_ALLOW_DIRTY_BACKEND !== 'true') {
  throw new Error(
    'Backend worktree is dirty; commit it or set DANANGMAP_ALLOW_DIRTY_BACKEND=true for local-only diagnostics.',
  );
}
await assertNoRouteMocks(resolve(frontendContext, 'e2e-real'));
const runCount = positiveInteger(process.env.DANANGMAP_FULLSTACK_RUNS ?? '2', 1, 2);
const artifactRoot = resolve('artifacts/fullstack');
await mkdir(artifactRoot, { recursive: true });

for (let run = 1; run <= runCount; run += 1) {
  const projectName =
    `danangmap-fullstack-${backendSha.slice(0, 8)}-${frontendSha.slice(0, 8)}-${run}`.toLowerCase();
  const runStamp = new Date().toISOString().replaceAll(':', '-');
  const runArtifactRoot = resolve(
    artifactRoot,
    `${runStamp}-${frontendSha.slice(0, 12)}-run-${run}`,
  );
  const playwrightReportDir = resolve(runArtifactRoot, 'playwright-report');
  const playwrightResultsDir = resolve(runArtifactRoot, 'test-results');
  await mkdir(playwrightReportDir, { recursive: true });
  await mkdir(playwrightResultsDir, { recursive: true });
  const composeArgs = [
    'compose',
    '--project-name',
    projectName,
    '-f',
    'compose.e2e.yml',
    '-f',
    'compose.fullstack.yml',
    '--profile',
    'fullstack',
  ];
  const environment = {
    ...process.env,
    DANANGMAP_BACKEND_SHA: backendSha,
    DANANGMAP_FRONTEND_CONTEXT: frontendContext.replaceAll('\\', '/'),
    DANANGMAP_FRONTEND_SHA: frontendSha,
    DANANGMAP_PLAYWRIGHT_REPORT_DIR: playwrightReportDir.replaceAll('\\', '/'),
    DANANGMAP_PLAYWRIGHT_RESULTS_DIR: playwrightResultsDir.replaceAll('\\', '/'),
  };
  console.log(
    `Full-stack run ${run}/${runCount}: backend=${backendSha} frontend=${frontendSha} project=${projectName}`,
  );
  let exitCode = 1;
  try {
    spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
    const startResult = spawnSync(
      'docker',
      [...composeArgs, 'up', '--build', '--detach', 'fullstack-browser'],
      { cwd: process.cwd(), env: environment, encoding: 'utf8', stdio: 'inherit' },
    );
    if (startResult.status === 0) {
      const waitResult = spawnSync('docker', [...composeArgs, 'wait', 'fullstack-browser'], {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
        stdio: 'inherit',
      });
      exitCode = waitResult.status ?? 1;
    }
  } finally {
    const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color'], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    });
    await writeFile(
      resolve(runArtifactRoot, 'compose.log'),
      `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
      'utf8',
    );
    spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
  }
  if (exitCode !== 0) throw new Error(`Full-stack harness run ${run} failed`);
}

console.log(
  `Full-stack harness passed ${runCount} fresh-volume run(s): backend=${backendSha} frontend=${frontendSha}.`,
);

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function positiveInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`DANANGMAP_FULLSTACK_RUNS must be ${minimum}..${maximum}`);
  }
  return parsed;
}

async function assertNoRouteMocks(directory) {
  const files = await sourceFiles(directory);
  if (files.length === 0) throw new Error(`No real-stack browser tests found under ${directory}`);
  const forbidden = [
    { pattern: /\b[$\p{ID_Start}_][$\p{ID_Continue}_]*\s*\.\s*route\s*\(/u, label: '*.route' },
    { pattern: /\broute\s*\.\s*(?:fulfill|abort|fallback)\s*\(/u, label: 'route response mock' },
  ];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) violations.push(`${file}: ${rule.label}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Real-stack route mocks are forbidden:\n${violations.join('\n')}`);
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) files.push(path);
  }
  return files;
}
