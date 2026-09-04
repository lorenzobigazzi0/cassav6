export function policyFromRoute(route) {
  if (!route) return null;
  if (route.public === true) return { category: "public" };
  if (route.debug === true) {
    return { category: "debug", permission: route.permission ?? null };
  }
  if (route.admin === true) return { category: "admin" };
  if (route.service) return { category: "serviceToken", service: route.service };
  if (route.permission) return { category: "permission", permission: route.permission };
  if (route.authRequired === true) return { category: "authenticated" };
  return null;
}

export function resolveRoutePolicy(method, pathname, registry = null) {
  const normalizedMethod = String(method ?? "").toUpperCase();
  if (normalizedMethod === "OPTIONS") return { category: "public" };
  const routePolicy = policyFromRoute(registry?.findRoute?.(normalizedMethod, pathname));
  if (routePolicy) return routePolicy;
  // Fallback per endpoint non ancora registrati: il vecchio default era authenticated.
  return { category: "authenticated" };
}
