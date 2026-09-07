import { Request } from 'express';

export function requestMeta(req: Request): { ipAddress: string | null; device: string | null } {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string) || req.ip || null,
    device: req.headers['user-agent'] || null,
  };
}
