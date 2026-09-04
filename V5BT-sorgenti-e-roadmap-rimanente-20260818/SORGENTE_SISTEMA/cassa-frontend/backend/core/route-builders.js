export function route(method, path, handlerKey, options = {}) {
  const safeMethod = String(method ?? "").toUpperCase();
  return {
    method: safeMethod,
    path,
    handlerKey,
    mutation: typeof options.mutation === "boolean" ? options.mutation : safeMethod !== "GET",
    ...options,
  };
}

export const publicRoute = (method, path, handlerKey, options = {}) =>
  route(method, path, handlerKey, { ...options, public: true, authRequired: false });

export const publicMutationRoute = (method, path, handlerKey, options = {}) =>
  publicRoute(method, path, handlerKey, {
    ...options,
    mutation: true,
    allowPublicMutation: true,
  });

export const authRoute = (method, path, handlerKey, options = {}) =>
  route(method, path, handlerKey, { ...options, authRequired: true });

export const permissionRoute = (method, path, handlerKey, permission, options = {}) =>
  route(method, path, handlerKey, { ...options, authRequired: true, permission });

export const adminRoute = (method, path, handlerKey, options = {}) =>
  route(method, path, handlerKey, { ...options, authRequired: true, admin: true });

export const debugRoute = (method, path, handlerKey, options = {}) =>
  route(method, path, handlerKey, {
    ...options,
    authRequired: true,
    debug: true,
    permission: options.permission ?? "manage_users",
  });

export const serviceRoute = (method, path, handlerKey, service, options = {}) =>
  route(method, path, handlerKey, { ...options, authRequired: true, service });
