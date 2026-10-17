declare module '@codegenie/serverless-express/src/middleware' {
  import type { NextFunction, Request, Response } from 'express';

  export function eventContext(options?: {
    reqPropKey?: string;
    deleteHeaders?: boolean;
  }): (req: Request, res: Response, next: NextFunction) => void;
}
