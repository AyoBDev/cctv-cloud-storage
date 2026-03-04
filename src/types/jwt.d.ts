import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      role: string;
      org_id: string | null;
      jti: string;
      type: 'access' | 'refresh';
    };
    user: {
      sub: string;
      role: string;
      org_id: string | null;
      jti: string;
      type: 'access' | 'refresh';
    };
  }
}
