export type PublicationFailureCode =
  | 'PUBLICATION_ACTOR_INELIGIBLE'
  | 'PUBLICATION_BASE_STALE'
  | 'PUBLICATION_BUILD_LIMIT_EXCEEDED'
  | 'PUBLICATION_INPUT_INVALID'
  | 'PUBLICATION_RETRY_EXHAUSTED'
  | 'PUBLICATION_SEPARATION_OF_DUTIES';

export class PublicationBuildError extends Error {
  constructor(readonly code: PublicationFailureCode) {
    super(code);
  }
}

export class PublicationInjectedRetryError extends Error {
  constructor(readonly point: string) {
    super('PUBLICATION_TEST_RETRY_INJECTED');
  }
}

export class PublicationInjectedTerminalError extends PublicationBuildError {
  constructor(readonly point: string) {
    super('PUBLICATION_INPUT_INVALID');
  }
}
