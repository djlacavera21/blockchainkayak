"use strict";
const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");
const { chromium } = require("@playwright/test");
const { DemoLedger } = require("../server/demo-ledger");
const { createApp } = require("../server/app");

async function main() {
  const ledger = new DemoLedger(":memory:");
  await ledger.seed();
  const token = "browser-test-only-token-000000000000";
  const server = createApp({ ledger, tokens: { manager: token } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/#token=${token}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("status of 409")
      )
        errors.push(message.text());
    });
    await page.goto(url);
    await page.getByText("Ledger connected", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.ok(await page.getByText("LOCAL DEMO", { exact: false }).count());
    await mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
    await page
      .getByRole("button", { name: "New rental", exact: false })
      .click();
    await page.locator("#rental-vessel").selectOption("K-01");
    const rentalId = await page.locator("[name=id]").inputValue();
    await page.getByLabel("Safety briefing completed with this crew").check();
    await page.getByLabel("Fitted PFDs confirmed for every paddler").check();
    await page.getByRole("button", { name: "Confirm checkout" }).click();
    await page.locator("#operation-dialog").waitFor({ state: "hidden" });
    const row = page
      .locator("#overview-rentals tr")
      .filter({ hasText: rentalId });
    await row.waitFor();
    await row.getByRole("button", { name: "Check in" }).click();
    await page.getByRole("button", { name: "Confirm return" }).click();
    await page.locator("#operation-dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    const card = page.locator(".equipment-card").filter({ hasText: "K-01" });
    await card.getByText("Inspection due", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Inspect", exact: true }).click();
    for (const name of [
      "Body / hull / flotation material checked",
      "Fittings, straps and attachments checked",
      "Clean and ready for use",
    ])
      await page.getByLabel(name, { exact: true }).check();
    await page
      .getByRole("button", { name: "Record inspection", exact: true })
      .click();
    await page.locator("#operation-dialog").waitFor({ state: "hidden" });
    await card.getByText("Available", { exact: true }).waitFor();
    await card.getByRole("button", { name: "History" }).click();
    await page
      .locator("#operation-dialog")
      .getByText("Rental returned", { exact: false })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Dock board", exact: true }).click();
    await page.getByRole("button", { name: "Update launch review" }).click();
    await page.getByLabel("Launch decision").selectOption("hold");
    await page
      .getByRole("button", { name: "Record launch review", exact: true })
      .click();
    await page.locator("#operation-dialog").waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "Launch on hold." }).waitFor();
    await page
      .getByRole("button", { name: "New rental", exact: false })
      .click();
    await page.getByLabel("Safety briefing completed with this crew").check();
    await page.getByLabel("Fitted PFDs confirmed for every paddler").check();
    await page.getByRole("button", { name: "Confirm checkout" }).click();
    await page
      .locator("#operation-form .form-error")
      .getByText("Launch is closed, held, or needs a fresh review", {
        exact: false,
      })
      .waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    mobile.on("pageerror", (error) => errors.push(error.message));
    await mobile.goto(url);
    await mobile.getByText("Ledger connected", { exact: true }).waitFor();
    assert.ok(
      await mobile.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      "Mobile document must fit viewport",
    );
    assert.ok(
      await mobile
        .locator("#overview-rentals")
        .getByRole("button", { name: "Check in" })
        .first()
        .isVisible(),
      "Mobile check-in must be directly visible",
    );
    await mobile.screenshot({
      path: "test-results/mobile.png",
      fullPage: true,
    });
    await mobile
      .getByRole("button", { name: "Equipment", exact: true })
      .click();
    assert.ok(
      await mobile.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      "Mobile fleet must fit viewport",
    );
    await page.getByRole("button", { name: "Lock session" }).click();
    assert.ok(await page.locator("#access-dialog").isVisible());
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("kayak-token")),
      null,
    );
    assert.deepEqual(errors, []);
    console.log(
      "Browser checks passed: desktop and mobile, token removal, checkout, return, inspection, history, launch hold, blocked departure, session lock, and no browser errors.",
    );
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ledger.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
