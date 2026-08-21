import type { Request } from 'express';

export interface RequestWithContext extends Request {
  requestId: string;
  principal?: {
    id: string;
    role: string;
    sessionId: string;
    displayName: string;
    mustChangePassword?: boolean;
  };
}
