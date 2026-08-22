import { spawnSync } from 'node:child_process';

describe('full-stack harness execution count policy', () => {
  it('derives the required execution total from durable phases and remaining specs', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-fullstack-harness.mjs', '--self-check-execution-count-policy'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('execution-count policy self-check passed');
  });
});
