import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
      },
      mutations: {
        networkMode: "always",
      },
    },
  });
}
