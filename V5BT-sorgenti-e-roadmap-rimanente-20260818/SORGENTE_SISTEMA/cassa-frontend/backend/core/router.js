function routeKey(method, pathname) {
  return `${String(method ?? "").toUpperCase()} ${String(pathname ?? "")}`;
}

function compilePathPattern(pathname) {
  const parts = String(pathname ?? "").split("/").filter(Boolean);
  const paramNames = [];
  const regexParts = parts.map((part) => {
    if (part.startsWith(":")) {
      paramNames.push(part.slice(1));
      return "([^/]+)";
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return {
    paramNames,
    regex: new RegExp(`^/${regexParts.join("/")}/?$`),
  };
}

export function validateRouteDefinitions(routes = [], handlers = {}) {
  const errors = [];
  const seen = new Set();
  routes.forEach((route, index) => {
    const method = String(route?.method ?? "").toUpperCase();
    const path = String(route?.path ?? "");
    const key = routeKey(method, path);
    if (!method || !path) {
      errors.push(`Route #${index + 1} senza method/path.`);
      return;
    }
    if (seen.has(key)) {
      errors.push(`Route duplicata: ${key}.`);
    }
    seen.add(key);

    const hasInlineHandler = typeof route.handler === "function";
    const handlerKey = String(route.handlerKey ?? "").trim();
    if (!hasInlineHandler && !handlerKey) {
      errors.push(`Route ${key} senza handler/handlerKey.`);
    } else if (!hasInlineHandler && typeof handlers[handlerKey] !== "function") {
      errors.push(`Route ${key} con handlerKey non risolto: ${handlerKey}.`);
    }

    const hasAuthPolicy =
      route.public === true ||
      route.authRequired === true ||
      Boolean(route.permission) ||
      route.admin === true ||
      route.debug === true ||
      Boolean(route.service);
    if (!hasAuthPolicy) {
      errors.push(`Route ${key} senza policy auth esplicita.`);
    }
    if (typeof route.mutation !== "boolean") {
      errors.push(`Route ${key} senza mutation:true/false.`);
    }

    if (route.public === true && route.mutation === true) {
      if (route.allowPublicMutation !== true) {
        errors.push(`Route ${key} mutativa pubblica senza allowPublicMutation:true.`);
      }
      if (typeof route.publicReason !== "string" || route.publicReason.trim().length < 12) {
        errors.push(`Route ${key} mutativa pubblica senza publicReason esplicito.`);
      }
      const maxBodySize = Number(route.maxBodySize);
      if (!Number.isFinite(maxBodySize) || maxBodySize <= 0 || maxBodySize > 65_536) {
        errors.push(`Route ${key} mutativa pubblica senza maxBodySize <= 65536.`);
      }
    }

    const nonGetReadOnly = !["GET", "HEAD", "OPTIONS"].includes(method) && route.mutation === false;
    if (nonGetReadOnly) {
      if (route.readOnly !== true) {
        errors.push(`Route ${key} con mutation:false su metodo non-GET senza readOnly:true.`);
      }
      if (typeof route.readOnlyReason !== "string" || route.readOnlyReason.trim().length < 8) {
        errors.push(`Route ${key} con mutation:false su metodo non-GET senza readOnlyReason esplicito.`);
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(`Route registry non valida:\n- ${errors.join("\n- ")}`);
  }
}

export function createRouteRegistry(routes = [], handlers = {}) {
  validateRouteDefinitions(routes, handlers);
  const normalizedRoutes = routes.map((route) => ({
    ...route,
    method: String(route.method ?? "").toUpperCase(),
    path: String(route.path ?? ""),
    pathPattern: String(route.path ?? "").includes(":") ? compilePathPattern(route.path) : null,
    handler:
      typeof route.handler === "function"
        ? route.handler
        : handlers[String(route.handlerKey ?? "").trim()],
  }));
  const byKey = new Map(normalizedRoutes.map((route) => [routeKey(route.method, route.path), route]));
  const dynamicRoutes = normalizedRoutes.filter((route) => route.pathPattern);

  return {
    routes: normalizedRoutes,
    findRoute(method, pathname) {
      const safeMethod = String(method ?? "").toUpperCase();
      const exact = byKey.get(routeKey(safeMethod, pathname)) ?? null;
      if (exact) return exact;
      const safePath = String(pathname ?? "");
      for (const route of dynamicRoutes) {
        if (route.method !== safeMethod) continue;
        const match = route.pathPattern.regex.exec(safePath);
        if (!match) continue;
        const params = {};
        route.pathPattern.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1] ?? "");
        });
        return { ...route, params };
      }
      return null;
    },
    getRoutePolicy(method, pathname) {
      return this.findRoute(method, pathname)?.policy ?? null;
    },
    isMutation(method, pathname) {
      const route = this.findRoute(method, pathname);
      return route ? route.mutation === true : null;
    },
  };
}

export async function dispatchRegisteredRoute(registry, req, res, requestUrl) {
  const route = registry?.findRoute?.(req.method, requestUrl.pathname) ?? null;
  if (!route) return false;
  if (route.params && typeof route.params === "object") {
    req.params = route.params;
  }
  await route.handler(req, res, requestUrl);
  return true;
}
