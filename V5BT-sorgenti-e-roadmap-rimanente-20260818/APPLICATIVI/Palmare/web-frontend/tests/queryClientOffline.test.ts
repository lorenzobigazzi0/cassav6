import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../src/shared/query/createAppQueryClient";

afterEach(() => {
  onlineManager.setOnline(undefined);
});

describe("React Query offline runtime", () => {
  it("runs a cold query even while the browser reports offline", async () => {
    onlineManager.setOnline(false);
    const queryFn = vi.fn(async () => "snapshot-offline");
    const queryClient = createAppQueryClient();

    await expect(
      queryClient.fetchQuery({ queryKey: ["offline-cold-start"], queryFn })
    ).resolves.toBe("snapshot-offline");
    expect(queryFn).toHaveBeenCalledOnce();

    queryClient.clear();
  });

  it("does not pause an offline mutation before its domain fallback can run", async () => {
    onlineManager.setOnline(false);
    const mutationFn = vi.fn(async (value: string) => `queued:${value}`);
    const queryClient = createAppQueryClient();
    const mutation = queryClient
      .getMutationCache()
      .build<string, Error, string, unknown>(queryClient, { mutationFn });

    await expect(mutation.execute("reservation")).resolves.toBe("queued:reservation");
    expect(mutationFn).toHaveBeenCalledOnce();

    queryClient.clear();
  });
});
