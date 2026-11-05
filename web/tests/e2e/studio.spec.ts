import { test, expect } from "@playwright/test";
test("real C WASM analysis and patient evaluation", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  await page.goto("/");
  await expect(page.getByText("C11 / WASM Engine Active")).toBeVisible();
  await expect(page.getByText("No problems found")).toBeVisible();
  await page.getByRole("button", { name: "Evaluate", exact: true }).click();
  await expect(page.getByText("3 patient results")).toBeVisible();
  await expect(page.locator(".outcome.true")).toHaveCount(2);
  await expect(page.locator(".outcome.false")).toHaveCount(1);
  await expect(
    page.getByText("Simulated Rule Output — Not for Clinical Use"),
  ).toBeVisible();
  await page
    .getByLabel("glucose_data row 1 value", { exact: true })
    .fill("300");
  await expect(
    page.getByText(
      "Results are from an earlier source or data snapshot. Evaluate again.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evaluate", exact: true }).click();
  await expect(page.locator(".outcome.true")).toHaveCount(3);
  await page
    .getByLabel("glucose_data row 1 value", { exact: true })
    .fill("bad");
  await expect(
    page.getByRole("button", { name: "Evaluate", exact: true }),
  ).toBeDisabled();
  expect(failures).toEqual([]);
});
test("presets evaluate with matched data and invalid syntax reports diagnostics", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("C11 / WASM Engine Active")).toBeVisible();
  for (const name of [
    "Inpatient glucose",
    "Sepsis early warning",
    "Recent heart rate",
  ]) {
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Evaluate", exact: true }).click();
    await expect(
      page.getByText("Evaluation complete", { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: /Diagnostic demonstration/ }).click();
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.locator(".problem-row").first()).toBeVisible();
});
test("responsive layout and workspace persistence", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("C11 / WASM Engine Active")).toBeVisible();
  await page
    .getByLabel("glucose_data row 1 value", { exact: true })
    .fill("222");
  await page.waitForTimeout(500);
  await page.reload();
  await expect(
    page.getByLabel("glucose_data row 1 value", { exact: true }),
  ).toHaveValue("222");
  await expect(
    page.getByRole("button", { name: "Evaluate", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('engine failure is visible and retry loads the real module',async({page})=>{
 await page.route('**/wasm/helix_engine.wasm',route=>route.abort());
 await page.goto('/');await expect(page.getByRole('button',{name:'Retry engine'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Evaluate',exact:true})).toBeDisabled();
 await page.unroute('**/wasm/helix_engine.wasm');await page.getByRole('button',{name:'Retry engine'}).click();
 await expect(page.getByText('C11 / WASM Engine Active')).toBeVisible();
 await page.getByRole('button',{name:'Evaluate',exact:true}).click();await expect(page.getByText('3 patient results')).toBeVisible();
});

test('CSV import preview, JSON rejection, and downloads preserve the workspace',async({page})=>{
 await page.goto('/');await expect(page.getByText('C11 / WASM Engine Active')).toBeVisible();
 const upload=page.locator('input[type=file][accept=".csv,.json"]');
 await upload.setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:1,evaluationTime:'2026-10-31T12:00:00Z',Bindings:{},tables:[{}]}))});
 await expect(page.getByText('Error: Invalid table structure')).toBeVisible();
 await expect(page.getByLabel('glucose_data row 1 value',{exact:true})).toHaveValue('180');
 await upload.setInputFiles({name:'data.csv',mimeType:'text/csv',buffer:Buffer.from('patient_id,value,timestamp\r\nP100,300,2026-10-31T11:00:00Z\r\n')});
 await expect(page.getByRole('dialog',{name:'CSV import preview'})).toBeVisible();
 await page.getByRole('button',{name:'Import as new table'}).click();
 await expect(page.getByLabel('Active data table')).toHaveValue('imported_1');
 await expect(page.getByLabel('imported_1 row 1 value',{exact:true})).toHaveValue('300');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save',exact:true}).click();
 expect((await download).suggestedFilename()).toBe('high_glucose_alert.helix');
});

test('keyboard tabs and mobile explorer remain usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByText('C11 / WASM Engine Active')).toBeVisible();
 await page.getByRole('tab',{name:'Tokens',exact:true}).click();await page.getByRole('tab',{name:'Tokens',exact:true}).press('ArrowRight');
 await expect(page.getByRole('tab',{name:'Evaluation Results',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:'Toggle explorer'}).click();await page.getByRole('button',{name:/Recent heart rate/}).click();
 await page.getByRole('button',{name:'Evaluate',exact:true}).click();await expect(page.getByText('2 patient results')).toBeVisible();
});
