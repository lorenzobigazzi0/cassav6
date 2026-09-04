import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("mobile payment method permissions", () => {
  it("usa nativamente allowedPaymentMethodIds invece del vecchio filtro DOM hardcoded", () => {
    const authTypes = readSource("src/types/auth.ts");
    const authStore = readSource("src/store/authStore.ts");
    const paymentWizard = readSource("src/pages/home/tables/components/TablePaymentWizard.tsx");
    const viteConfig = readSource("vite.config.ts");

    expect(authTypes).toContain("allowedPaymentMethodIds?: string[]");
    expect(authStore).toContain("AUTH_STORAGE_KEYS.allowedPaymentMethodIds");
    expect(paymentWizard).toContain("PAYMENT_METHOD_ID_BY_KEY");
    expect(paymentWizard).toContain("allowedPaymentMethodSet");
    expect(paymentWizard).toContain("allowedPaymentMethodSet.has");
    expect(viteConfig).not.toContain("mobile-giada-payment-method-filter.js?v=");
  });
});
