import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const minimumFrontendSha = 'cbb31e6b7901cd30f2fca8ba81ebe2f24e7e9d7f';
const activationLayerSlug = 'durable-publication-activation';
const durableSpec = 'durable-publication-progress.spec.ts';
const remainingSpecs = [
  'account-import-invite.spec.ts',
  'layer-configuration-create.spec.ts',
  'layer-configuration-lifecycle.spec.ts',
  'publication-history-rollback.spec.ts',
  'spatial-publication.spec.ts',
];
const realStackSpecs = [durableSpec, ...remainingSpecs];
const phaseNames = ['queue', 'progress', 'crashed', 'terminal'];
const expectedFailureAnnotationPattern =
  /\b[$\p{ID_Start}_][$\p{ID_Continue}_]*\s*(?:\.\s*fail\b|\[\s*(['"])fail\1\s*\])/u;
const commandTimeouts = Object.freeze({
  dockerBuild: 15 * 60_000,
  dockerLifecycle: 10 * 60_000,
  playwright: 6 * 60_000,
  dockerRun: 5 * 60_000,
  dockerLogs: 2 * 60_000,
  dockerControl: 60_000,
  git: 30_000,
});
let activeCommandJournal = null;

if (process.argv.includes('--self-check-source-policy')) {
  assertExpectedFailureAnnotationGuard();
  console.log('Full-stack exact-spec source policy self-check passed.');
  process.exit(0);
}

const frontendContext = resolve(
  process.env.DANANGMAP_FRONTEND_CONTEXT ?? '../danangmap-frontend-history',
);
const frontendSha = git(['-C', frontendContext, 'rev-parse', 'HEAD']).trim();
const backendSha = git(['rev-parse', 'HEAD']).trim();
const expectedFrontendSha = requiredSha('DANANGMAP_FRONTEND_SHA');
const expectedBackendSha = requiredSha('DANANGMAP_BACKEND_SHA');

equal(frontendSha, expectedFrontendSha, 'Frontend SHA');
equal(backendSha, expectedBackendSha, 'Backend SHA');
if (
  !gitSuccess([
    '-C',
    frontendContext,
    'merge-base',
    '--is-ancestor',
    minimumFrontendSha,
    frontendSha,
  ])
) {
  throw new Error(
    `Frontend ${frontendSha} must descend from durable UI commit ${minimumFrontendSha}.`,
  );
}
const frontendDirty = git(['-C', frontendContext, 'status', '--porcelain']).trim();
const backendDirty = git(['status', '--porcelain']).trim();
if (frontendDirty) throw new Error('Frontend worktree must be clean for exact-SHA acceptance.');
if (backendDirty) throw new Error('Backend worktree must be clean for exact-SHA acceptance.');

await assertNoRouteOrServiceMocks(resolve(frontendContext, 'e2e-real'), realStackSpecs);
const runCount = exactRunCount(process.env.DANANGMAP_FULLSTACK_RUNS ?? '2');
const artifactRoot = resolve('artifacts/fullstack');
await mkdir(artifactRoot, { recursive: true });

for (let run = 1; run <= runCount; run += 1) await runFreshStack(run);

console.log(
  `Full-stack activation passed ${runCount} fresh-volume run(s): backend=${backendSha} frontend=${frontendSha}.`,
);

async function runFreshStack(run) {
  const startedAt = new Date();
  const projectName =
    `danangmap-fullstack-${backendSha.slice(0, 8)}-${frontendSha.slice(0, 8)}-${run}`.toLowerCase();
  const runStamp = startedAt.toISOString().replaceAll(':', '-');
  const runRoot = resolve(
    artifactRoot,
    `${runStamp}-${backendSha.slice(0, 12)}-${frontendSha.slice(0, 12)}-run-${run}`,
  );
  const reportRoot = resolve(runRoot, 'playwright-report');
  const resultsRoot = resolve(runRoot, 'test-results');
  const phaseDirectory = resolve(runRoot, 'phase');
  const runNonce = randomBytes(18).toString('hex');
  await Promise.all(
    [runRoot, reportRoot, resultsRoot, phaseDirectory].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

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
    DANANGMAP_FRONTEND_CONTEXT: portable(frontendContext),
    DANANGMAP_FRONTEND_SHA: frontendSha,
    DANANGMAP_PLAYWRIGHT_REPORT_DIR: portable(reportRoot),
    DANANGMAP_PLAYWRIGHT_RESULTS_DIR: portable(resultsRoot),
    DANANGMAP_PHASE_DIR: portable(phaseDirectory),
    DANANGMAP_RUN_NONCE: runNonce,
    ASYNC_PUBLICATION_ENABLED: 'true',
  };
  const phaseEvidence = {};
  const specResults = [];
  const controlResults = [];
  const commandExecutions = [];
  const logCaptures = [];
  const revisionLabelAssertions = [];
  const evidenceErrors = [];
  let barrierName = null;
  let failure = null;
  let composeConfigSha256 = null;
  let services = [];
  let preQueueWorkers = null;

  console.log(
    `Activation run ${run}/${runCount}: backend=${backendSha} frontend=${frontendSha} project=${projectName}`,
  );
  activeCommandJournal = commandExecutions;
  try {
    composeConfigSha256 = sha256(
      checked('docker', [...composeArgs, 'config'], environment, { capture: true }).stdout,
    );
    checked('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], environment);
    checked(
      'docker',
      [...composeArgs, 'up', '--build', '--detach', '--wait', 'gateway', 'mailpit'],
      environment,
    );
    checked(
      'docker',
      [
        ...composeArgs,
        'build',
        'test',
        'fullstack-smoke',
        'fullstack-browser',
        'publication-barrier',
        'worker',
        'crash-worker',
      ],
      environment,
    );
    recordedCommand(
      controlResults,
      'fullstack-smoke',
      'initial-stack-smoke',
      'docker',
      [...composeArgs, 'run', '--rm', '--no-deps', 'fullstack-smoke'],
      environment,
    );

    phaseEvidence.seed = await captureDatabaseEvidence(composeArgs, environment, 'seed', null);
    await atomicJson(resolve(phaseDirectory, 'input.json'), {
      schemaVersion: 1,
      runNonce,
      backendSha,
      frontendSha,
      layerSlug: activationLayerSlug,
      layerId: phaseEvidence.seed.fixture.layerId,
      revisionId: phaseEvidence.seed.fixture.revisionId,
      publishedRevisionId: phaseEvidence.seed.fixture.publishedRevisionId,
      expectedFeatureTotal: 3,
      baseline: {
        snapshotId: phaseEvidence.seed.pointer.activeSnapshotId,
        generation: phaseEvidence.seed.pointer.generation,
        activePointerEtag: phaseEvidence.seed.pointer.activePointerEtag,
      },
    });
    await writeEvidenceFile(runRoot, 'db-seed.json', phaseEvidence.seed);

    await runBrowserSpec({
      composeArgs,
      environment,
      reportRoot,
      resultsRoot,
      spec: durableSpec,
      phase: 'queue',
      specResults,
      controlResults,
      beforeBrowser: async () => {
        preQueueWorkers = assertWorkerServicesAbsent(composeArgs, environment);
        await writeEvidenceFile(runRoot, 'pre-queue-workers.json', preQueueWorkers);
      },
    });
    const queuedPhase = await readPhaseFile(phaseDirectory, 'queue', runNonce, {
      layerId: phaseEvidence.seed.fixture.layerId,
      revisionId: phaseEvidence.seed.fixture.revisionId,
    });
    const jobId = queuedPhase.jobId;
    if (!uuid(jobId)) throw new Error('queue.json must contain the durable publication job UUID.');
    phaseEvidence.queue = await captureDatabaseEvidence(composeArgs, environment, 'queue', jobId);
    await writeEvidenceFile(runRoot, 'db-queue.json', phaseEvidence.queue);

    barrierName = `${projectName}-barrier`;
    checked(
      'docker',
      [
        ...composeArgs,
        'run',
        '--detach',
        '--no-deps',
        '--name',
        barrierName,
        '-e',
        `DANANGMAP_PUBLICATION_JOB_ID=${jobId}`,
        'publication-barrier',
      ],
      environment,
      { capture: true },
    );
    await waitForFile(resolve(phaseDirectory, 'barrier-ready.json'), 30_000);
    await readPhaseFile(phaseDirectory, 'barrier-ready', runNonce, { jobId });
    checked('docker', [...composeArgs, 'up', '--detach', '--no-deps', 'crash-worker'], environment);

    await runBrowserSpec({
      composeArgs,
      environment,
      reportRoot,
      resultsRoot,
      spec: durableSpec,
      phase: 'progress',
      specResults,
      controlResults,
    });
    await readPhaseFile(phaseDirectory, 'progress', runNonce, {
      jobId,
      layerId: phaseEvidence.seed.fixture.layerId,
      revisionId: phaseEvidence.seed.fixture.revisionId,
    });
    phaseEvidence.progress = await captureDatabaseEvidence(
      composeArgs,
      environment,
      'progress',
      jobId,
    );
    await writeEvidenceFile(runRoot, 'db-progress.json', phaseEvidence.progress);

    const crashWorkerId = checked(
      'docker',
      [...composeArgs, 'ps', '--quiet', 'crash-worker'],
      environment,
      { capture: true },
    ).stdout.trim();
    if (!crashWorkerId) throw new Error('Crash worker container is not running at checkpoint.');
    checked('docker', [...composeArgs, 'kill', '--signal', 'SIGKILL', 'crash-worker'], environment);
    const crashWorkerLogs = capturedCommand(
      logCaptures,
      'crash-worker',
      'docker',
      [...composeArgs, 'logs', '--no-color', 'crash-worker'],
      environment,
    );
    await writeFile(
      resolve(runRoot, 'crash-worker.log'),
      `${crashWorkerLogs.stdout}${crashWorkerLogs.stderr}`,
      'utf8',
    );
    const crashInspect = dockerInspect(crashWorkerId);
    const crashState = crashInspect.State ?? {};
    if (crashState.Status !== 'exited' || crashState.ExitCode !== 137 || crashState.OOMKilled) {
      throw new Error(
        `Crash worker did not record the expected SIGKILL exit: ${JSON.stringify(crashState)}.`,
      );
    }
    await writeEvidenceFile(runRoot, 'crash-worker.json', safeContainerInspect(crashInspect));
    revisionLabelAssertions.push(
      ...assertContainerAndImageRevision(
        safeContainerInspect(crashInspect),
        'crash-worker',
        'danangmap.backend.revision',
        backendSha,
      ),
    );
    checked('docker', [...composeArgs, 'rm', '--force', 'crash-worker'], environment);

    checked('docker', ['stop', '--time', '15', barrierName], environment);
    await waitForFile(resolve(phaseDirectory, 'barrier-released.json'), 10_000);
    const barrierInspect = dockerInspect(barrierName);
    const barrierState = barrierInspect.State ?? {};
    if (barrierState.Status !== 'exited' || barrierState.ExitCode !== 0) {
      throw new Error(`Publication barrier did not stop cleanly: ${JSON.stringify(barrierState)}.`);
    }
    await writeEvidenceFile(
      runRoot,
      'barrier-container.json',
      safeContainerInspect(barrierInspect),
    );
    revisionLabelAssertions.push(
      ...assertContainerAndImageRevision(
        safeContainerInspect(barrierInspect),
        'publication-barrier',
        'danangmap.backend.revision',
        backendSha,
      ),
    );
    const barrierLogs = capturedCommand(
      logCaptures,
      'publication-barrier',
      'docker',
      ['logs', barrierName],
      environment,
    );
    await writeFile(
      resolve(runRoot, 'barrier.log'),
      `${barrierLogs.stdout}${barrierLogs.stderr}`,
      'utf8',
    );
    checked('docker', ['rm', '--force', barrierName], environment);
    barrierName = null;

    phaseEvidence.crashed = await captureDatabaseEvidence(
      composeArgs,
      environment,
      'crashed',
      jobId,
    );
    await writeEvidenceFile(runRoot, 'db-crashed.json', phaseEvidence.crashed);
    await runBrowserSpec({
      composeArgs,
      environment,
      reportRoot,
      resultsRoot,
      spec: durableSpec,
      phase: 'crashed',
      specResults,
      controlResults,
    });
    await readPhaseFile(phaseDirectory, 'crashed', runNonce, {
      jobId,
      layerId: phaseEvidence.seed.fixture.layerId,
      revisionId: phaseEvidence.seed.fixture.revisionId,
    });

    await waitForLeaseExpiry(phaseEvidence.crashed.job.leaseExpiresAt, 30_000);
    phaseEvidence.leaseExpired = await captureDatabaseEvidence(
      composeArgs,
      environment,
      'lease-expired',
      jobId,
    );
    await writeEvidenceFile(runRoot, 'db-lease-expired.json', phaseEvidence.leaseExpired);
    checked('docker', [...composeArgs, 'up', '--detach', '--no-deps', 'worker'], environment);

    await runBrowserSpec({
      composeArgs,
      environment,
      reportRoot,
      resultsRoot,
      spec: durableSpec,
      phase: 'terminal',
      specResults,
      controlResults,
    });
    await readPhaseFile(phaseDirectory, 'terminal', runNonce, {
      jobId,
      layerId: phaseEvidence.seed.fixture.layerId,
      revisionId: phaseEvidence.seed.fixture.revisionId,
    });
    phaseEvidence.terminal = await captureDatabaseEvidence(
      composeArgs,
      environment,
      'terminal',
      jobId,
    );
    await writeEvidenceFile(runRoot, 'db-terminal.json', phaseEvidence.terminal);

    for (const spec of remainingSpecs) {
      await runBrowserSpec({
        composeArgs,
        environment,
        reportRoot,
        resultsRoot,
        spec,
        phase: null,
        specResults,
        controlResults,
      });
    }
    if (specResults.length !== 9 || specResults.some((result) => result.exitCode !== 0)) {
      throw new Error('The required four durable phases and five real-stack specs did not pass.');
    }
    checked(
      'docker',
      [
        ...composeArgs,
        'up',
        '--no-start',
        '--no-deps',
        'fullstack-browser',
        'test',
        'fullstack-smoke',
      ],
      environment,
    );
    services = await captureServiceInventory(composeArgs, environment);
    revisionLabelAssertions.push(
      ...assertServiceRevision(services, 'migrate', 'danangmap.backend.revision', backendSha, {
        status: 'exited',
        running: false,
        exitCode: 0,
      }),
      ...assertServiceRevision(services, 'seed', 'danangmap.backend.revision', backendSha, {
        status: 'exited',
        running: false,
        exitCode: 0,
      }),
      ...assertServiceRevision(services, 'api', 'danangmap.backend.revision', backendSha),
      ...assertServiceRevision(services, 'worker', 'danangmap.backend.revision', backendSha),
      ...assertServiceRevision(services, 'test', 'danangmap.backend.revision', backendSha, {
        status: 'created',
        running: false,
      }),
      ...assertServiceRevision(
        services,
        'fullstack-smoke',
        'danangmap.backend.revision',
        backendSha,
        { status: 'created', running: false },
      ),
      ...assertServiceRevision(services, 'frontend', 'danangmap.frontend.revision', frontendSha),
      ...assertServiceRevision(
        services,
        'fullstack-browser',
        'danangmap.frontend.revision',
        frontendSha,
        { status: 'created', running: false },
      ),
    );
    await writeEvidenceFile(runRoot, 'services.json', services);
    const images = checked('docker', [...composeArgs, 'images', '--format', 'json'], environment, {
      capture: true,
    }).stdout;
    await writeFile(resolve(runRoot, 'images.jsonl'), images, 'utf8');
  } catch (caught) {
    failure = asError(caught);
  } finally {
    if (barrierName) {
      const barrierCleanup = checked('docker', ['rm', '--force', barrierName], environment, {
        allowFailure: true,
      });
      if (barrierCleanup.status !== 0) {
        evidenceErrors.push(commandFailureMessage('barrier cleanup', barrierCleanup));
        failure ??= new Error('Publication barrier cleanup failed.');
      }
    }
    const logs = capturedCommand(
      logCaptures,
      'compose',
      'docker',
      [...composeArgs, 'logs', '--no-color'],
      environment,
      { required: false },
    );
    await writeFile(resolve(runRoot, 'compose.log'), `${logs.stdout}${logs.stderr}`, 'utf8');
    if (logs.status !== 0) {
      evidenceErrors.push(commandFailureMessage('compose log capture', logs));
      failure ??= new Error('Mandatory Compose log capture failed.');
    }

    const down = checked(
      'docker',
      [...composeArgs, 'down', '-v', '--remove-orphans'],
      environment,
      { allowFailure: true },
    );
    if (down.status !== 0) {
      evidenceErrors.push(commandFailureMessage('compose teardown', down));
      failure ??= new Error('Full-stack teardown failed.');
    }
    const residuals = residualAudit(projectName);
    await writeEvidenceFile(runRoot, 'residuals.json', residuals);
    if (!residuals.passed) {
      for (const check of residuals.checks.filter((candidate) => candidate.exitCode !== 0)) {
        evidenceErrors.push(
          commandFailureMessage(`residual ${check.resource} audit`, {
            status: check.exitCode,
            timedOut: check.timedOut,
            signal: check.signal,
            timeoutMilliseconds: check.timeoutMilliseconds,
          }),
        );
      }
      failure ??= new Error('One or more residual Docker audit commands failed.');
    }
    if (residuals.containers.length || residuals.networks.length || residuals.volumes.length) {
      failure ??= new Error('Full-stack teardown left project containers, networks or volumes.');
    }

    const finishedAt = new Date();
    const files = await fileInventory(runRoot, new Set(['evidence.json', 'evidence.json.sha256']));
    const manifest = {
      schemaVersion: 1,
      status: failure ? 'failed' : 'passed',
      run,
      projectName,
      transport: { origin: 'https://gateway', tls: 'Caddy internal CA' },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMilliseconds: finishedAt.getTime() - startedAt.getTime(),
      revisions: {
        backend: { expected: expectedBackendSha, actual: backendSha, dirty: false },
        frontend: {
          expected: expectedFrontendSha,
          actual: frontendSha,
          minimumDurableUiAncestor: minimumFrontendSha,
          dirty: false,
        },
      },
      composeConfigSha256,
      requiredSpecs: realStackSpecs,
      durablePhases: phaseNames,
      executions: specResults,
      controls: controlResults,
      commands: commandExecutions,
      logCaptures,
      preQueueWorkers,
      revisionLabelAssertions,
      invariants: summarizeInvariants(phaseEvidence),
      serviceCount: services.length,
      residuals,
      evidenceErrors,
      failure: failure ? { name: failure.name, message: failure.message } : null,
      files,
    };
    const evidencePath = resolve(runRoot, 'evidence.json');
    await writeEvidenceFile(runRoot, 'evidence.json', manifest);
    const evidenceDigest = sha256(await readFile(evidencePath));
    await writeFile(resolve(runRoot, 'evidence.json.sha256'), `${evidenceDigest}  evidence.json\n`);
    activeCommandJournal = null;
  }

  if (failure) throw new Error(`Full-stack activation run ${run} failed: ${failure.message}`);
}

async function runBrowserSpec({
  composeArgs,
  environment,
  reportRoot,
  resultsRoot,
  spec,
  phase,
  specResults,
  controlResults,
  beforeBrowser,
}) {
  const specName = spec.replace(/\.spec\.ts$/u, '');
  const executionName = phase ? `${specName}-${phase}` : specName;
  resetAuthentication(composeArgs, environment, controlResults, executionName);
  if (beforeBrowser) await beforeBrowser();
  const specReport = resolve(reportRoot, executionName);
  const specResultsDirectory = resolve(resultsRoot, executionName);
  await Promise.all(
    [specReport, specResultsDirectory].map((directory) => mkdir(directory, { recursive: true })),
  );
  const executionEnvironment = {
    ...environment,
    DANANGMAP_PLAYWRIGHT_REPORT_DIR: portable(specReport),
    DANANGMAP_PLAYWRIGHT_RESULTS_DIR: portable(specResultsDirectory),
  };
  const startedAt = new Date();
  const phaseArguments = phase ? ['-e', `DANANGMAP_DURABLE_PUBLICATION_PHASE=${phase}`] : [];
  const result = checked(
    'docker',
    [
      ...composeArgs,
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'PLAYWRIGHT_JSON_OUTPUT_FILE=/app/test-results/invocation-result.json',
      ...phaseArguments,
      'fullstack-browser',
      'npx',
      'playwright',
      'test',
      '--config=playwright.real.config.ts',
      '--project=real-stack',
      '--reporter=line,html,json',
      `e2e-real/${spec}`,
    ],
    executionEnvironment,
    { allowFailure: true },
  );
  const finishedAt = new Date();
  let playwright = null;
  let playwrightResultError = null;
  try {
    playwright = await readPlaywrightResult(
      resolve(specResultsDirectory, 'invocation-result.json'),
    );
  } catch (caught) {
    playwrightResultError = asError(caught).message;
  }
  specResults.push({
    spec,
    phase,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMilliseconds: finishedAt.getTime() - startedAt.getTime(),
    exitCode: result.status,
    timedOut: result.timedOut,
    signal: result.signal,
    timeoutMilliseconds: result.timeoutMilliseconds,
    playwright,
    playwrightResultError,
  });
  if (result.status !== 0) {
    throw new Error(
      `${spec}${phase ? ` phase ${phase}` : ''} ${commandFailureMessage('Playwright', result)}.`,
    );
  }
  if (!playwright) {
    throw new Error(
      `${spec}${phase ? ` phase ${phase}` : ''} has no valid Playwright JSON result: ${playwrightResultError}.`,
    );
  }
  if (
    playwright.passed <= 0 ||
    playwright.failed !== 0 ||
    playwright.skipped !== 0 ||
    playwright.flaky !== 0
  ) {
    throw new Error(
      `${spec}${phase ? ` phase ${phase}` : ''} has unacceptable Playwright counts: ${JSON.stringify(playwright)}.`,
    );
  }
}

function resetAuthentication(composeArgs, environment, controlResults, executionName) {
  recordedCommand(
    controlResults,
    'auth-reset',
    executionName,
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
    environment,
  );
}

function recordedCommand(results, kind, name, command, args, environment) {
  const startedAt = new Date();
  const result = checked(command, args, environment, { allowFailure: true });
  const finishedAt = new Date();
  results.push({
    kind,
    name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMilliseconds: finishedAt.getTime() - startedAt.getTime(),
    exitCode: result.status,
    timedOut: result.timedOut,
    signal: result.signal,
    timeoutMilliseconds: result.timeoutMilliseconds,
  });
  if (result.status !== 0) {
    throw new Error(`${kind} ${name} ${commandFailureMessage('command', result)}.`);
  }
}

function capturedCommand(results, name, command, args, environment, options = {}) {
  const startedAt = new Date();
  const result = checked(command, args, environment, { capture: true, allowFailure: true });
  const finishedAt = new Date();
  results.push({
    kind: 'mandatory-log-capture',
    name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMilliseconds: finishedAt.getTime() - startedAt.getTime(),
    exitCode: result.status,
    timedOut: result.timedOut,
    signal: result.signal,
    timeoutMilliseconds: result.timeoutMilliseconds,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
  });
  if (options.required !== false && result.status !== 0) {
    throw new Error(`${name} ${commandFailureMessage('log capture', result)}.`);
  }
  return result;
}

function assertWorkerServicesAbsent(composeArgs, environment) {
  const evidence = {
    capturedAt: new Date().toISOString(),
    services: [],
  };
  for (const service of ['worker', 'crash-worker']) {
    const all = checked(
      'docker',
      [...composeArgs, 'ps', '--all', '--quiet', service],
      environment,
      { capture: true },
    )
      .stdout.trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    const running = checked('docker', [...composeArgs, 'ps', '--quiet', service], environment, {
      capture: true,
    })
      .stdout.trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    evidence.services.push({ service, containerIds: all, runningContainerIds: running });
    if (all.length > 0 || running.length > 0) {
      throw new Error(`${service} must be absent immediately before the queue phase.`);
    }
  }
  return evidence;
}

function assertServiceRevision(
  services,
  service,
  label,
  expected,
  expectedState = { status: 'running', running: true },
) {
  const container = services.find(
    (candidate) => candidate.labels?.['com.docker.compose.service'] === service,
  );
  if (!container) throw new Error(`No ${service} container was present for revision evidence.`);
  for (const [key, expectedValue] of Object.entries(expectedState)) {
    if (container.state[key] !== expectedValue) {
      throw new Error(
        `${service} state ${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(container.state[key])}.`,
      );
    }
  }
  return assertContainerAndImageRevision(container, service, label, expected);
}

function assertContainerAndImageRevision(container, service, label, expected) {
  const containerAssertion = revisionAssertion(
    service,
    'container-label',
    label,
    expected,
    container.labels?.[label],
    container.id,
  );
  const image = dockerInspect(container.imageId);
  const imageAssertion = revisionAssertion(
    service,
    'image-label',
    label,
    expected,
    image.Config?.Labels?.[label],
    image.Id,
  );
  return [containerAssertion, imageAssertion];
}

function revisionAssertion(subject, kind, label, expected, actual, artifactId) {
  if (actual !== expected) {
    throw new Error(
      `${subject} ${kind} ${label}: expected ${expected}, received ${String(actual)}.`,
    );
  }
  return { subject, kind, label, expected, actual, artifactId, passed: true };
}

async function captureDatabaseEvidence(composeArgs, environment, stage, jobId) {
  const jobArguments = jobId ? ['-e', `DANANGMAP_PUBLICATION_JOB_ID=${jobId}`] : [];
  const result = checked(
    'docker',
    [
      ...composeArgs,
      'run',
      '--rm',
      '--no-deps',
      '-e',
      `DANANGMAP_PUBLICATION_EVIDENCE_STAGE=${stage}`,
      '-e',
      `DANANGMAP_ACTIVATION_LAYER_SLUG=${activationLayerSlug}`,
      ...jobArguments,
      'test',
      'node',
      'scripts/publication-phase-evidence.mjs',
    ],
    environment,
    { capture: true },
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('DANANGMAP_EVIDENCE_JSON='));
  if (!line) throw new Error(`Database evidence stage ${stage} returned no JSON payload.`);
  return JSON.parse(line.slice('DANANGMAP_EVIDENCE_JSON='.length));
}

async function readPhaseFile(phaseDirectory, phase, runNonce, expected = {}) {
  const path = resolve(phaseDirectory, `${phase}.json`);
  await waitForFile(path, 5_000);
  const value = JSON.parse(await readFile(path, 'utf8'));
  equal(value.schemaVersion, 1, `${phase}.json schemaVersion`);
  equal(value.runNonce, runNonce, `${phase}.json runNonce`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    equal(value[key], expectedValue, `${phase}.json ${key}`);
  }
  return value;
}

async function readPlaywrightResult(path) {
  const report = JSON.parse(await readFile(path, 'utf8'));
  const stats = report?.stats;
  const passed = strictNonNegativeInteger(stats?.expected, 'Playwright expected count');
  const failed = strictNonNegativeInteger(stats?.unexpected, 'Playwright unexpected count');
  const skipped = strictNonNegativeInteger(stats?.skipped, 'Playwright skipped count');
  const flaky = strictNonNegativeInteger(stats?.flaky, 'Playwright flaky count');
  return {
    passed,
    failed,
    skipped,
    flaky,
    total: passed + failed + skipped + flaky,
    durationMilliseconds: strictNonNegativeNumber(stats?.duration, 'Playwright duration'),
    startTime: typeof stats?.startTime === 'string' ? stats.startTime : null,
  };
}

async function waitForLeaseExpiry(leaseExpiresAt, timeoutMilliseconds) {
  const expiry = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(expiry)) throw new Error('Crash evidence has no valid lease expiry.');
  const waitMilliseconds = Math.max(0, expiry - Date.now() + 1_250);
  if (waitMilliseconds > timeoutMilliseconds) {
    throw new Error(`Publication lease expiry exceeds the ${timeoutMilliseconds}ms bound.`);
  }
  if (waitMilliseconds > 0) await delay(waitMilliseconds);
}

async function captureServiceInventory(composeArgs, environment) {
  const ids = checked('docker', [...composeArgs, 'ps', '--all', '--quiet'], environment, {
    capture: true,
  })
    .stdout.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.map((id) => safeContainerInspect(dockerInspect(id)));
}

function safeContainerInspect(inspect) {
  return {
    id: inspect.Id,
    name: String(inspect.Name ?? '').replace(/^\//u, ''),
    imageId: inspect.Image,
    image: inspect.Config?.Image ?? null,
    labels: inspect.Config?.Labels ?? {},
    state: {
      status: inspect.State?.Status ?? null,
      running: inspect.State?.Running ?? false,
      exitCode: inspect.State?.ExitCode ?? null,
      oomKilled: inspect.State?.OOMKilled ?? false,
      startedAt: inspect.State?.StartedAt ?? null,
      finishedAt: inspect.State?.FinishedAt ?? null,
    },
  };
}

function dockerInspect(target) {
  const result = checked('docker', ['inspect', target], process.env, { capture: true });
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed[0])
    throw new Error(`Docker inspect returned no ${target}.`);
  return parsed[0];
}

function residualAudit(projectName) {
  const checks = [
    residualCheck('containers', [
      'ps',
      '--all',
      '--filter',
      `label=com.docker.compose.project=${projectName}`,
      '--format',
      '{{.ID}} {{.Names}}',
    ]),
    residualCheck('networks', [
      'network',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${projectName}`,
      '--format',
      '{{.Name}}',
    ]),
    residualCheck('volumes', [
      'volume',
      'ls',
      '--filter',
      `label=com.docker.compose.project=${projectName}`,
      '--format',
      '{{.Name}}',
    ]),
  ];
  return {
    passed: checks.every((check) => check.exitCode === 0),
    checks,
    containers: checks.find((check) => check.resource === 'containers').lines,
    networks: checks.find((check) => check.resource === 'networks').lines,
    volumes: checks.find((check) => check.resource === 'volumes').lines,
  };
}

function residualCheck(resource, args) {
  const result = checked('docker', args, process.env, { capture: true, allowFailure: true });
  return {
    resource,
    exitCode: result.status,
    timedOut: result.timedOut,
    signal: result.signal,
    timeoutMilliseconds: result.timeoutMilliseconds,
    error: result.errorMessage,
    lines: result.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function summarizeInvariants(evidence) {
  if (!evidence.seed) return { captured: false };
  return {
    captured: true,
    runNonce: evidence.seed.runNonce,
    layerId: evidence.seed.fixture.layerId,
    revisionId: evidence.seed.fixture.revisionId,
    baseline: {
      snapshotId: evidence.seed.pointer.activeSnapshotId,
      generation: evidence.seed.pointer.generation,
      snapshots: evidence.seed.counts.snapshots,
    },
    queue: evidence.queue
      ? {
          jobId: evidence.queue.job.id,
          attempts: evidence.queue.job.attempts,
          status: evidence.queue.job.status,
          pointerSnapshotId: evidence.queue.pointer.activeSnapshotId,
        }
      : null,
    progress: evidence.progress
      ? {
          completedUnits: evidence.progress.job.featureProcessed,
          totalUnits: evidence.progress.job.featureTotal,
          batches: evidence.progress.counts.batches,
          pointerSnapshotId: evidence.progress.pointer.activeSnapshotId,
        }
      : null,
    crash: evidence.crashed
      ? {
          attempts: evidence.crashed.job.attempts,
          leaseExpiresAt: evidence.crashed.job.leaseExpiresAt,
          pointerSnapshotId: evidence.crashed.pointer.activeSnapshotId,
        }
      : null,
    terminal: evidence.terminal
      ? {
          status: evidence.terminal.job.status,
          attempts: evidence.terminal.job.attempts,
          recoveredLeases: evidence.terminal.worker.recoveredLeases,
          snapshotId: evidence.terminal.job.resultSnapshotId,
          generation: evidence.terminal.job.resultGeneration,
          snapshots: evidence.terminal.counts.snapshots,
          publishParticipants: evidence.terminal.counts.publishParticipants,
          publishedWorkflowEvents: evidence.terminal.counts.publishedWorkflowEvents,
          publishedAudits: evidence.terminal.counts.publishedAudits,
        }
      : null,
  };
}

async function fileInventory(root, excludedNames) {
  const files = await allFiles(root);
  const inventory = [];
  for (const file of files) {
    if (excludedNames.has(file.split(/[\\/]/u).at(-1))) continue;
    const data = await readFile(file);
    const details = await stat(file);
    inventory.push({
      path: relative(root, file).replaceAll('\\', '/'),
      bytes: details.size,
      sha256: sha256(data),
    });
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeEvidenceFile(root, name, value) {
  await atomicJson(resolve(root, name), value);
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function waitForFile(path, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMilliseconds}ms waiting for ${path}.`);
}

function checked(command, args, environment, options = {}) {
  const capture = options.capture === true;
  const commandClass = classifyCommand(command, args);
  const startedAt = new Date();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 256 * 1024 * 1024,
    timeout: commandClass.timeoutMilliseconds,
  });
  const finishedAt = new Date();
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const normalized = {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    signal: result.signal ?? null,
    errorMessage: result.error?.message ?? null,
    timeoutMilliseconds: commandClass.timeoutMilliseconds,
  };
  if (activeCommandJournal && command === 'docker') {
    activeCommandJournal.push({
      commandClass: commandClass.name,
      command,
      args,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMilliseconds: finishedAt.getTime() - startedAt.getTime(),
      timeoutMilliseconds: commandClass.timeoutMilliseconds,
      exitCode: normalized.status,
      timedOut: normalized.timedOut,
      signal: normalized.signal,
      error: normalized.errorMessage,
    });
  }
  if (normalized.status !== 0 && !options.allowFailure) {
    const detail = capture
      ? normalized.stderr.trim() || normalized.stdout.trim() || normalized.errorMessage
      : normalized.errorMessage;
    throw new Error(
      `${command} ${args.slice(0, 8).join(' ')} ${commandFailureMessage('command', normalized)}${detail ? `: ${detail}` : ''}.`,
    );
  }
  return normalized;
}

function classifyCommand(command, args) {
  if (command !== 'docker') {
    return { name: 'local-control', timeoutMilliseconds: commandTimeouts.dockerControl };
  }
  if (args.includes('playwright')) {
    return { name: 'playwright', timeoutMilliseconds: commandTimeouts.playwright };
  }
  if (args.includes('build') || (args.includes('up') && args.includes('--build'))) {
    return { name: 'docker-build', timeoutMilliseconds: commandTimeouts.dockerBuild };
  }
  if (args.includes('up') || args.includes('down')) {
    return { name: 'docker-lifecycle', timeoutMilliseconds: commandTimeouts.dockerLifecycle };
  }
  if (args.includes('run')) {
    return { name: 'docker-run', timeoutMilliseconds: commandTimeouts.dockerRun };
  }
  if (args.includes('logs')) {
    return { name: 'docker-logs', timeoutMilliseconds: commandTimeouts.dockerLogs };
  }
  return { name: 'docker-control', timeoutMilliseconds: commandTimeouts.dockerControl };
}

function commandFailureMessage(label, result) {
  return `${label} failed with exit ${result.status}${result.timedOut ? ` after timeout ${result.timeoutMilliseconds ?? 'unknown'}ms` : ''}${result.signal ? ` signal ${result.signal}` : ''}`;
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: commandTimeouts.git });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function gitSuccess(args) {
  return spawnSync('git', args, { stdio: 'ignore', timeout: commandTimeouts.git }).status === 0;
}

async function assertNoRouteOrServiceMocks(directory, requiredSpecs) {
  const files = await sourceFiles(directory);
  if (files.length === 0) throw new Error(`No real-stack browser tests found under ${directory}`);
  const requiredPaths = new Set(requiredSpecs.map((spec) => resolve(directory, spec)));
  const missingSpecs = [...requiredPaths].filter((spec) => !files.includes(spec));
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
    {
      pattern: /\/var\/run\/docker\.sock|docker\s+(?:compose|exec|run)/u,
      label: 'browser Docker control',
    },
  ];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(source)) violations.push(`${file}: ${rule.label}`);
    }
    if (requiredPaths.has(file) && expectedFailureAnnotationPattern.test(source)) {
      violations.push(`${file}: Playwright expected-failure annotation`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`Real-stack source policy violations are forbidden:\n${violations.join('\n')}`);
  }
}

function assertExpectedFailureAnnotationGuard() {
  const forbiddenCases = [
    'test.fail();',
    "test . fail (true, 'reason');",
    "durableTest['fail']();",
    'e2eAlias [ "fail" ] (condition);',
  ];
  const allowedCases = ["test('literal pass', async () => {});", 'expect(result.failed).toBe(0);'];
  for (const source of forbiddenCases) {
    if (!expectedFailureAnnotationPattern.test(source)) {
      throw new Error(`Expected-failure source guard missed: ${source}`);
    }
  }
  for (const source of allowedCases) {
    if (expectedFailureAnnotationPattern.test(source)) {
      throw new Error(`Expected-failure source guard rejected safe source: ${source}`);
    }
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:[cm]?[jt]sx?|json|log|html)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(path)));
    else files.push(path);
  }
  return files;
}

function requiredSha(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${name} must be a full lowercase Git SHA.`);
  return value;
}

function exactRunCount(value) {
  const parsed = Number(value);
  if (parsed !== 2) {
    throw new Error('DANANGMAP_FULLSTACK_RUNS must be exactly 2 for activation acceptance.');
  }
  return parsed;
}

function strictNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer; got ${JSON.stringify(value)}.`);
  }
  return value;
}

function strictNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number; got ${JSON.stringify(value)}.`);
  }
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function portable(path) {
  return path.replaceAll('\\', '/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
