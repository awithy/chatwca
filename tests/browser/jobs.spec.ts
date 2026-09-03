import { expect, test } from "@playwright/test";

async function openJobs(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduled jobs" })).toBeVisible();
}

async function createJob(
  page: import("@playwright/test").Page,
  name: string,
  options: { daily?: boolean; hooks?: boolean } = {},
): Promise<void> {
  await page.getByRole("button", { name: "New job" }).click();
  const form = page.getByRole("form", { name: "Create job" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Saved prompt").fill(`Prompt for ${name}`);
  if (options.daily === true) {
    await form.getByRole("button", { name: "Daily", exact: true }).click();
    await form.getByLabel("Local time").fill("07:30");
    await form.getByLabel("Timezone").selectOption("America/New_York");
  } else {
    await form.getByLabel("Interval minutes").fill("240");
  }
  if (options.hooks === true) {
    await form.getByLabel("Pre-run script").fill("/tmp/chatwca-browser-hooks/pre.sh");
    await expect(form.getByText(/service user's authority/)).toBeVisible();
    await form.getByRole("checkbox", { name: /I understand and trust/ }).check();
  }
  await form.getByRole("button", { name: "Create job" }).click();
  await expect(form).toHaveCount(0);
}

test("rail navigation is accessible and jobs adapt to a narrow viewport", async ({ page }) => {
  await openJobs(page);
  const navigation = page.getByRole("navigation", { name: "Application sections" });
  await expect(navigation.getByRole("button", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(navigation).toHaveCSS("flex-direction", "row");
  await navigation.getByRole("button", { name: "Conversations" }).focus();
  await expect(navigation.getByRole("button", { name: "Conversations" })).toBeFocused();
});

test("creates interval and daily jobs, discloses hooks, and filters authoritative rows", async ({ page }) => {
  await openJobs(page);
  const suffix = Date.now().toString();
  const interval = `Interval fixture ${suffix}`;
  const daily = `Daily fixture ${suffix}`;
  await createJob(page, interval, { hooks: true });
  await createJob(page, daily, { daily: true });

  const intervalRow = page.locator("tr").filter({ hasText: interval });
  await expect(intervalRow).toContainText("Every 4 hours");
  const dailyRow = page.locator("tr").filter({ hasText: daily });
  await expect(dailyRow).toContainText("Daily at 07:30 America/New_York");

  await page.getByLabel("Search").fill(daily);
  await expect(dailyRow).toBeVisible();
  await expect(intervalRow).toHaveCount(0);
  await page.getByLabel("Search").fill("");
  await page.getByLabel("Workspace").selectOption({ label: "Browser workspace" });
  await expect(dailyRow).toBeVisible();
});

test("live runs lock mutation, retain disable and abort, escape hook output, and link conversations", async ({ page }) => {
  await openJobs(page);
  const name = `Active hooks ${Date.now().toString()}`;
  await createJob(page, name, { hooks: true });
  const row = page.locator("tr").filter({ hasText: name });
  await row.getByRole("button", { name: "Run now" }).click();
  await expect(row.getByText(/Running/).first()).toBeVisible();
  await expect(row.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(row.getByRole("button", { name: "Disable" })).toBeEnabled();
  await expect(row.getByRole("button", { name: "Abort" })).toBeEnabled();

  await row.getByRole("button", { name: "View runs" }).click();
  const dialog = page.getByRole("dialog", { name: "Run history" });
  await dialog.getByRole("button", { name: /Running/ }).first().click();
  await expect(dialog.getByText("<script>alert('not html')</script>")).toBeVisible();
  await expect(dialog.locator("script")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open generated conversation" }).click();
  await expect(page.getByText("Scheduled job · View run")).toBeVisible();
  await expect(page.getByLabel("Edit conversation title")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Abort", exact: true })).toBeEnabled();
  await page.getByText("Scheduled job · View run").click();
  await expect(page.getByRole("dialog", { name: "Run history" })).toBeVisible();
});

test("missing generated sessions show a stable fallback and row actions enable, edit, and delete", async ({ page }) => {
  await openJobs(page);
  const name = `Missing fixture ${Date.now().toString()}`;
  await createJob(page, name);
  let row = page.locator("tr").filter({ hasText: name });
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Enable" }).click();
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: "Edit job" });
  await edit.getByLabel("Name").fill(`${name} updated`);
  await edit.getByRole("button", { name: "Save changes" }).click();
  row = page.locator("tr").filter({ hasText: `${name} updated` });
  await row.getByRole("button", { name: "Run now" }).click();
  await row.getByRole("button", { name: "View runs" }).click();
  const dialog = page.getByRole("dialog", { name: "Run history" });
  await dialog.getByRole("button", { name: /Running/ }).first().click();
  await expect(dialog.getByText("Conversation unavailable")).toBeVisible();
  await dialog.getByRole("button", { name: "Abort run" }).click();
  await dialog.getByRole("button", { name: "Close run history" }).click();
  page.once("dialog", (confirmation) => confirmation.accept());
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});
