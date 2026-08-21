import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pinnedFrontendSha = '244538488ecb4fd26f910c33d4a499ef23a7d040';
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
if (dirty) throw new Error('Frontend worktree must be clean for exact-pin full-stack acceptance');
const backendDirty = git(['status', '--porcelain']).trim();
if (backendDirty)
  throw new Error('Backend worktree must be clean for exact-pin full-stack acceptance');
const realStackSpecs = [
  'account-import-invite.spec.ts',
  'layer-configuration-create.spec.ts',
  'layer-configuration-lifecycle.spec.ts',
  'publication-history-rollback.spec.ts',
  'spatial-publication.spec.ts',
];
await assertNoRouteOrServiceMocks(resolve(frontendContext, 'e2e-real'), realStackSpecs);
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
    const initialDown = spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
    if (initialDown.status !== 0) {
      throw new Error(`Full-stack run ${run} could not establish a clean pre-run stack`);
    }
    const startResult = spawnSync(
      'docker',
      [...composeArgs, 'up', '--build', '--detach', '--wait', 'gateway', 'worker', 'mailpit'],
      { cwd: process.cwd(), env: environment, encoding: 'utf8', stdio: 'inherit' },
    );
    if (startResult.status === 0) {
      const testImagesBuild = spawnSync(
        'docker',
        [...composeArgs, 'build', 'fullstack-smoke', 'fullstack-browser'],
        {
          cwd: process.cwd(),
          env: environment,
          encoding: 'utf8',
          stdio: 'inherit',
        },
      );
      exitCode = testImagesBuild.status ?? 1;
      if (exitCode === 0) {
        const smokeResult = spawnSync(
          'docker',
          [...composeArgs, 'run', '--rm', '--no-deps', 'fullstack-smoke'],
          {
            cwd: process.cwd(),
            env: environment,
            encoding: 'utf8',
            stdio: 'inherit',
          },
        );
        exitCode = smokeResult.status ?? 1;
      }
      if (exitCode === 0) {
        const failedSpecs = [];
        for (const spec of realStackSpecs) {
          const specName = spec.replace(/\.spec\.ts$/u, '');
          const specReportDir = resolve(playwrightReportDir, specName);
          const specResultsDir = resolve(playwrightResultsDir, specName);
          await mkdir(specReportDir, { recursive: true });
          await mkdir(specResultsDir, { recursive: true });
          const specEnvironment = {
            ...environment,
            DANANGMAP_PLAYWRIGHT_REPORT_DIR: specReportDir.replaceAll('\\', '/'),
            DANANGMAP_PLAYWRIGHT_RESULTS_DIR: specResultsDir.replaceAll('\\', '/'),
          };
          const resetResult = spawnSync(
            'docker',
            [
              ...composeArgs,
              'run',
              '--rm',
              '--no-deps',
              '-e',
              'NODE_ENV=test',
              '-e',
              'DANANGMAP_E2E_AUTH_RESET=true',
              'seed',
            ],
            { cwd: process.cwd(), env: specEnvironment, encoding: 'utf8', stdio: 'inherit' },
          );
          if (resetResult.status !== 0) {
            failedSpecs.push(`${spec} (auth reset failed)`);
            continue;
          }
          const specResult = spawnSync(
            'docker',
            [
              ...composeArgs,
              'run',
              '--rm',
              '--no-deps',
              'fullstack-browser',
              'npx',
              'playwright',
              'test',
              '--config=playwright.real.config.ts',
              '--project=real-stack',
              `e2e-real/${spec}`,
            ],
            { cwd: process.cwd(), env: specEnvironment, encoding: 'utf8', stdio: 'inherit' },
          );
          if (specResult.status !== 0) failedSpecs.push(spec);
        }
        if (failedSpecs.length > 0) {
          console.error(`Independent real-stack specs failed: ${failedSpecs.join(', ')}`);
          exitCode = 1;
        }
      }
    }
  } finally {
    let evidenceError;
    try {
      const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color'], {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8',
      });
      if (logs.status !== 0) {
        throw new Error(`Full-stack run ${run} could not capture compose logs`);
      }
      await writeFile(
        resolve(runArtifactRoot, 'compose.log'),
        `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
        'utf8',
      );
    } catch (caught) {
      evidenceError = caught;
    }
    const finalDown = spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
    });
    if (finalDown.status !== 0) {
      const evidenceSuffix = evidenceError ? ' (compose evidence capture also failed)' : '';
      throw new Error(`Full-stack run ${run} teardown failed${evidenceSuffix}`);
    }
    if (evidenceError) throw evidenceError;
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

async function assertNoRouteOrServiceMocks(directory, requiredSpecs) {
  const files = await sourceFiles(directory);
  if (files.length === 0) throw new Error(`No real-stack browser tests found under ${directory}`);
  const missingSpecs = requiredSpecs.filter((spec) => !files.includes(resolve(directory, spec)));
  if (missingSpecs.length > 0) {
    throw new Error(`Required real-stack tests were not scanned: ${missingSpecs.join(', ')}`);
  }
  const forbidden = [
    { pattern: /\b[$\p{ID_Start}_][$\p{ID_Continue}_]*\s*\.\s*route\s*\(/u, label: '*.route' },
    { pattern: /\broute\s*\.\s*(?:fulfill|abort|fallback)\s*\(/u, label: 'route response mock' },
    {
      pattern: /NEXT_PUBLIC_DANANGMAP_(?:DEMO_MODE|AUTH_E2E_MODE|USER_IMPORT_E2E_MODE)/u,
      label: 'demo/service mock mode',
    },
  ];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) violations.push(`${file}: ${rule.label}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Real-stack route/service mocks are forbidden:\n${violations.join('\n')}`);
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
