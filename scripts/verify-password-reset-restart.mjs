const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) {
  throw new Error('Expected phase must be before or after');
}

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const idempotencyKey =
  process.env.PASSWORD_RESET_RESTART_KEY ?? '0198d54e-3869-7d85-9d7f-44ed2dde17bf';
const email = 'restart-idempotency-probe@invalid.danangmap.test';

async function requestReset(targetEmail) {
  return fetch(`${apiBaseUrl}/api/v1/auth/password/reset:request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ email: targetEmail }),
  });
}

async function expectProblem(response, status, code) {
  const body = await response.json();
  if (response.status !== status || body?.code !== code) {
    throw new Error(
      `Expected ${status} ${code}; received ${response.status}: ${JSON.stringify(body)}`,
    );
  }
}

if (phase === 'before') {
  const response = await requestReset(email);
  const body = await response.json();
  if (response.status !== 202 || body?.data?.status !== 'accepted') {
    throw new Error(`Initial reset request failed: ${response.status} ${JSON.stringify(body)}`);
  }
  process.stdout.write('Password-reset receipt committed before API restart.\n');
} else {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await requestReset(email);
    const body = await response.json();
    if (response.status !== 202 || body?.data?.status !== 'accepted') {
      throw new Error(
        `Restart replay ${attempt + 1} failed: ${response.status} ${JSON.stringify(body)}`,
      );
    }
  }
  await expectProblem(
    await requestReset('changed-restart-probe@invalid.danangmap.test'),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  process.stdout.write(
    'Password-reset receipt replayed after API restart without consuming rate-limit slots.\n',
  );
}
