import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMenuCatalogPatches,
  fetchMenuCatalogForSession,
  fetchMenuCatalogUpdatesForSession,
  type MenuCatalog,
} from "../src/api/menu";
import { apiFetch } from "../src/api/baseUrl";
import { readOfflineMenu, recordOfflineMenu } from "../src/domain/offlineConfiguration/repository";

vi.mock("../src/api/baseUrl", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../src/domain/offlineConfiguration/repository", () => ({
  readOfflineMenu: vi.fn(),
  recordOfflineMenu: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedReadOfflineMenu = vi.mocked(readOfflineMenu);
const mockedRecordOfflineMenu = vi.mocked(recordOfflineMenu);

const session = {
  token: "session-token",
  userId: "user-menu-empty",
  deviceUuid: "device-menu-empty",
  activityId: "activity-menu-empty",
  roomId: "room-menu-empty",
};

const staleCatalog: MenuCatalog = {
  departments: [{ id: "dept-old", name: "Vecchio reparto" }],
  categories: [{ id: "cat-old", departmentId: "dept-old", name: "Vecchia categoria" }],
  products: [
    {
      id: "product-old",
      sku: "product-old",
      departmentId: "dept-old",
      categoryId: "cat-old",
      name: "Prodotto obsoleto",
      description: "",
      ingredients: [],
      allergens: [],
      isFrozen: false,
      variants: [],
      available: true,
      price: 1,
      imageUrl: null,
    },
  ],
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedReadOfflineMenu.mockReset();
  mockedRecordOfflineMenu.mockReset();
  mockedReadOfflineMenu.mockResolvedValue(null);
  mockedRecordOfflineMenu.mockResolvedValue(null);
});

describe("authoritative empty menu", () => {
  it("records and returns an authoritative empty catalog", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ version: 21, departments: [], categories: [], products: [] })
    );

    await expect(fetchMenuCatalogForSession(session)).resolves.toEqual({
      version: 21,
      catalog: { departments: [], categories: [], products: [] },
    });
    expect(mockedRecordOfflineMenu).toHaveBeenCalledWith(
      { userId: session.userId, activityId: session.activityId },
      session.roomId,
      {
        version: 21,
        catalog: { departments: [], categories: [], products: [] },
      }
    );
  });

  it("replaces the previous catalog when an empty version arrives as an update", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ version: 22, departments: [], categories: [], products: [] })
    );

    const result = await fetchMenuCatalogUpdatesForSession({ ...session, sinceVersion: 21 });
    expect(result).toEqual({
      version: 22,
      updates: [
        {
          type: "replace_catalog",
          catalog: { departments: [], categories: [], products: [] },
        },
      ],
    });
    expect(applyMenuCatalogPatches(staleCatalog, result.updates)).toEqual({
      departments: [],
      categories: [],
      products: [],
    });
  });

  it("does not interpret a malformed non-empty payload as an empty catalog", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 23,
        departments: [{ id: "", name: "" }],
        categories: [],
        products: [],
      })
    );
    mockedReadOfflineMenu.mockResolvedValueOnce({ version: 20, catalog: staleCatalog });

    await expect(fetchMenuCatalogForSession(session)).resolves.toMatchObject({
      version: 20,
      catalog: {
        departments: staleCatalog.departments,
        categories: staleCatalog.categories,
        products: [{ id: "product-old", name: "Prodotto obsoleto" }],
      },
    });
    expect(mockedRecordOfflineMenu).not.toHaveBeenCalled();
  });
});
