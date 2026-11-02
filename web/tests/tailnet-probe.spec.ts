import { expect, test } from "@playwright/test";

test("Tailnet probe binds the proof through the authenticated Hub without sending cookies to the probe", async ({
  page,
}) => {
  const nonce = "a".repeat(48),
    device = "b".repeat(64),
    proof = "c".repeat(64);
  let seen = false;
  await page.route("**/api/tailnet/probe", async (route) => {
    expect(route.request().headers()["x-workdeck-csrf"]).toBe("fixture-csrf");
    await route.fulfill({
      json: {
        enabled: true,
        challenge: nonce,
        probe_url: "https://probe.example/probe",
      },
    });
  });
  await page.route("https://probe.example/probe", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "http://127.0.0.1:18168",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "content-type",
        },
      });
      return;
    }
    expect(route.request().headers().cookie).toBeUndefined();
    expect(route.request().postDataJSON()).toEqual({ challenge: nonce });
    seen = true;
    await route.fulfill({
      headers: { "access-control-allow-origin": "http://127.0.0.1:18168" },
      json: { device, proof },
    });
  });
  await page.route("**/api/tailnet/probe/complete", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      challenge: nonce,
      device,
      proof,
    });
    await route.fulfill({ json: { available: true, valid_for_seconds: 120 } });
  });
  await page.goto("/tests/fixtures/tailnet-probe.html");
  await expect(page.locator("#status")).toHaveText("available");
  expect(seen).toBe(true);
});

test("unreachable Tailnet probe falls back without claiming availability", async ({
  page,
}) => {
  await page.route("**/api/tailnet/probe", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        challenge: "a".repeat(48),
        probe_url: "https://probe.example/probe",
      },
    }),
  );
  await page.route("https://probe.example/probe", (route) => route.abort());
  await page.goto("/tests/fixtures/tailnet-probe.html");
  await expect(page.locator("#status")).toHaveText("unavailable");
});
