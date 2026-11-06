import { env } from 'cloudflare:workers';
import { defineMiddleware } from 'astro:middleware';
import type { Env } from '../worker/types';
import { verifyAccess } from '../worker/access';

export const onRequest = defineMiddleware(async (context, next) => {
  const store = env as Env;
  context.locals.storeDB = store.DB;
  if (context.url.pathname.startsWith('/admin/previa/') && context.url.origin === store.STORE_ORIGIN) {
    context.locals.adminPreview = Boolean(await verifyAccess(context.request, store));
  }
  return next();
});
