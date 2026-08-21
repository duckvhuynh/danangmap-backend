import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const frontendContext = resolve(process.env.DANANGMAP_FRONTEND_CONTEXT ?? '../danangmap-frontend');
const frontendSha = git(['-C', frontendContext, 'rev-parse', 'HEAD']).trim();
const expectedSha = process.env.DANANGMAP_FRONTEND_SHA?.trim();
if (expectedSha && frontendSha !== expectedSha) {
  throw new Error(`Frontend SHA mismatch: expected ${expectedSha}, found ${frontendSha}`);
}
const dirty = git(['-C', frontendContext, 'status', '--porcelain']).trim();
if (dirty && process.env.DANANGMAP_ALLOW_DIRTY_FRONTEND !== 'true') {
  throw new Error(
    'Frontend worktree is dirty; commit it or set DANANGMAP_ALLOW_DIRTY_FRONTEND=true for local-only diagnostics.',
  );
}
const runCount = positiveInteger(process.env.DANANGMAP_FULLSTACK_RUNS ?? '1', 1, 2);
const artifactRoot = resolve('artifacts/fullstack');
await mkdir(artifactRoot, { recursive: true });

for (let run = 1; run <= runCount; run += 1) {
  const projectName = `danangmap-fullstack-${frontendSha.slice(0, 8)}-${run}`.toLowerCase();
  const composeArgs = [
    'compose',
    '--project-name',
    projectName,
    '-f',
    'compose.fullstack.yml',
    '--profile',
    'fullstack',
  ];
  const environment = {
    ...process.env,
    DANANGMAP_FRONTEND_CONTEXT: frontendContext.replaceAll('\\', '/'),
  };
  let exitCode = 1;
  try {
    const result = spawnSync(
      'docker',
      [
        ...composeArgs,
        'up',
        '--build',
        '--abort-on-container-exit',
        '--exit-code-from',
        'fullstack-smoke',
        'fullstack-smoke',
      ],
      { cwd: process.cwd(), env: environment, encoding: 'utf8', stdio: 'inherit' },
    );
    exitCode = result.status ?? 1;
  } finally {
    const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color'], {
      cwd: process.cwd(),
      env: environment,
      encoding: 'utf8',
    });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    await writeFile(
      resolve(artifactRoot, `${stamp}-${frontendSha.slice(0, 12)}-run-${run}.log`),
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
  `Full-stack harness passed ${runCount} fresh-volume run(s) against frontend ${frontendSha}.`,
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
