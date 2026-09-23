// SPDX-License-Identifier: MIT
/**
 * The recovery page with a security key, end to end in a browser.
 *
 * A virtual authenticator stands in for the YubiKey — with PRF, as the key on
 * the two phones has it. The page asks it for an identity (two touches), binds
 * that identity to OrbitDB (one more), makes a list and writes to it.
 *
 * This is the path the phones took on 21 September and fell off at the third
 * touch, with a TypeError from inside the identity provider. Nothing here
 * leaves the machine: the backup and the pointer need a public network, and
 * belong to the bench.
 */
import { test, expect } from "@playwright/test";

/** A security key on this page: CTAP2, discoverable credentials, PRF. */
async function attachSecurityKey(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** The passkey the phones already hold: discoverable, with PRF, for this origin. */
async function enrolPasskey(page) {
  await page.evaluate(async () => {
    await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: "funkpost recovery test" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: "bench",
          displayName: "bench",
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: {} },
      },
    });
  });
}

test("the key alone gives an identity OrbitDB takes, and it writes", async ({ page }) => {
  // Nothing may leave this machine before backup is pressed.
  const strayed = [];
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    async (route) => {
      strayed.push(route.request().url());
      await route.abort();
    },
  );

  await page.goto("/");
  // Up to the menu of all pages, first in the pill.
  await expect(page.locator(".ls-pill a.ls-up")).toHaveAttribute(
    "href",
    "https://nikrause.github.io/funkpost/",
  );
  // The technical layer is closed, and opening it shows something at once —
  // before any step has run, which is when it used to show nothing.
  await expect(page.getByTestId("how-it-works")).toBeHidden();
  await page.getByTestId("details").click();
  await expect(page.getByTestId("how-it-works")).toBeVisible();
  await page.getByTestId("details").click();
  await expect(page.getByTestId("how-it-works")).toBeHidden();

  await attachSecurityKey(page);
  await enrolPasskey(page);

  await page.getByTestId("use-key").click();
  await expect(page.getByTestId("did-fingerprint")).toHaveText(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/, {
    timeout: 30_000,
  });
  // The third touch: the signing key bound to the identity, OrbitDB running on it.
  await expect(page.locator(".log")).toContainText("OrbitDB is running with that identity", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(page.locator(".step").first()).toHaveAttribute("data-status", "done");

  // The numbers two phones are compared by are there, but behind one button.
  await expect(page.getByTestId("did-fingerprint")).toBeHidden();
  await page.getByTestId("details").click();
  await expect(page.getByTestId("did-fingerprint")).toBeVisible();
  await expect(page.locator(".log")).toBeVisible();

  await page.getByTestId("make-list").click();
  await expect(page.locator(".log")).toContainText("list open:", { timeout: 30_000 });

  await page.getByLabel("new entry").fill("Milch kaufen");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator("li", { hasText: "Milch kaufen" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("error")).toHaveCount(0);

  expect(strayed).toEqual([]);
});

test("speaks German and English, and has a light and a dark look — both kept", async ({ page }) => {
  await page.goto("/");
  // The test browser asks for English, and for the light look.
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: /Tell the page who you are/ })).toBeVisible();

  await page.getByRole("link", { name: "Deutsch" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: /Identität vom Schlüssel/ })).toBeVisible();
  await expect(page.getByTestId("use-key")).toHaveText("Sicherheitsschlüssel verwenden");
  await expect(page).toHaveTitle(/eine Liste, die das Telefon übersteht/);
  // The address says it too, so the page QR opens in the same language.
  expect(new URL(page.url()).searchParams.get("lang")).toBe("de");

  const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await ground();
  await page.getByRole("button", { name: "Zum dunklen Modus wechseln" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(ground).not.toBe(light);

  // Both kept: the address no longer says, storage does.
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("use-key")).toHaveText("Sicherheitsschlüssel verwenden");
  expect(await ground()).not.toBe(light);
});

/**
 * The backup coming back over libp2p, with every gateway refused.
 *
 * Opt-in (`RECOVERY_LIVE=true`), because unlike the test above this one has to
 * leave the machine twice: it uploads a real backup to Aleph, and then dials
 * Aleph's own node over webrtc-direct to fetch it. The suite otherwise fails a
 * run that strays off localhost, and that rule is worth keeping.
 *
 * What it proves is the claim in NiKrause/funkpost#127: a phone whose gateways
 * are all unreachable still gets its list back.
 */
const live = process.env.RECOVERY_LIVE === "true";

test.describe("the peer path", () => {
  test.skip(!live, "set RECOVERY_LIVE=true — this one really uploads and really dials");
  test.setTimeout(240_000);

  test("the list comes back over libp2p when no gateway will answer", async ({ page }) => {
    await page.goto("/?fetch=first");
    await attachSecurityKey(page);
    await enrolPasskey(page);
    // The fingerprints and the log live behind the details toggle.
    await page.getByTestId("details").click();

    await page.getByTestId("use-key").click();
    await expect(page.locator(".step").first()).toHaveAttribute("data-status", "done", {
      timeout: 60_000,
    });

    await page.getByTestId("make-list").click();
    await expect(page.locator(".log")).toContainText("list open:", { timeout: 60_000 });
    await page.getByLabel("new entry").fill("über libp2p zurückgeholt");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await page.getByTestId("dehydrate").click();
    await expect(page.locator(".log")).toContainText("pointer", { timeout: 120_000 });

    // From here the gateways do not exist. The pointer lookup is a different
    // host and stays reachable — this is about the bytes, not the name.
    await page.route("**/ipfs/**", (route) => route.abort("connectionrefused"));

    // "Forget" reloads the page 600 ms later, so waiting for the current load
    // state returns immediately and the next click lands on a page about to be
    // thrown away. Wait for the reload itself.
    const reloaded = page.waitForEvent("load");
    await page.getByTestId("forget").click();
    await reloaded;
    // The virtual authenticator belongs to the CDP session, not the document,
    // so it survives the reload with its passkey — attaching a second one here
    // would give the page two keys and an identity it never backed up with.
    await page.getByTestId("use-key").click();
    await expect(page.locator(".step").first()).toHaveAttribute("data-status", "done", {
      timeout: 60_000,
    });

    await page.getByTestId("hydrate").click();

    // The entry is back, and the page says which way it came.
    await expect(page.locator("li", { hasText: "über libp2p zurückgeholt" })).toBeVisible({
      timeout: 180_000,
    });
    await expect(page.locator('.path[data-state="good"]')).toContainText(/libp2p/);
    await expect(page.locator('.path[data-state="bad"]')).toBeVisible();
    await expect(page.getByTestId("error")).toHaveCount(0);
  });
});

/**
 * Choosing where the backup goes — the chooser from #128.
 *
 * Nothing here leaves the machine: it is about what the page asks for, what it
 * keeps, and what it refuses to do without. The services themselves are
 * exercised by the storage probe, which has the reader's own keys.
 */
test("the backup goes where the reader says, and a key is asked for before it is needed", async ({
  page,
}) => {
  await page.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => route.abort(),
  );
  await page.goto("/");

  // Aleph is on by default and needs no account: this page works with nothing
  // typed in, which is the reason it is the default.
  await expect(page.getByTestId("service-aleph")).toBeChecked();
  await expect(page.getByTestId("service-pinata")).not.toBeChecked();
  await expect(page.getByTestId("key-pinata")).toHaveCount(0);

  await page.getByTestId("service-pinata").check();
  await expect(page.getByTestId("key-pinata")).toBeVisible();
  await expect(page.getByTestId("gateway-pinata")).toBeVisible();

  // A service without its key is named, and backup stays out of reach — the
  // reader finds out now rather than at the upload.
  await expect(page.getByTestId("missing-key")).toContainText("Pinata");
  await expect(page.getByTestId("dehydrate")).toBeDisabled();

  await page.getByTestId("key-pinata").fill("not-a-real-jwt");
  await expect(page.getByTestId("missing-key")).toHaveCount(0);

  // The choice survives a reload, because a key typed on a phone should not
  // have to be typed twice.
  await page.reload();
  await expect(page.getByTestId("service-pinata")).toBeChecked();
  await expect(page.getByTestId("key-pinata")).toHaveValue("not-a-real-jwt");

  // And it can be taken back.
  await page.getByTestId("forget-keys").click();
  await expect(page.getByTestId("service-pinata")).not.toBeChecked();
  await expect(page.getByTestId("key-pinata")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("service-pinata")).not.toBeChecked();
});
