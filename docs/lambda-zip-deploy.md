# Deploy ingest Lambda from a zip (this repository)

The script `npm run package:lambda` builds **`dist/lambda-ingest.zip`** containing `pipeline/` and `fixtures/` so paths match what `pipeline/lambda-handler.js` expects.

---

## Part A — Build the zip locally

1. Open a terminal in the **repository root** (the folder that contains `package.json`).
2. Run:

   ```bash
   npm run package:lambda
   ```

3. Confirm the file exists: **`dist/lambda-ingest.zip`**.

If `tar` fails on Windows, the script retries with PowerShell `Compress-Archive`. If both fail, update Windows or run the commands from Git Bash where `zip`/`tar` is available.

---

## Part B — Connect the zip to your Lambda function (AWS Console)

1. Sign in to the [AWS Management Console](https://console.aws.amazon.com/) and open **Lambda** in the same **Region** where you created the function (for example **us-east-1**).

2. Open your function (for example **Emails-Thunderbird-MCP**).

3. Select the **Code** tab.

4. Under **Code source**, choose **Upload from** → **.zip file**.

5. Click **Upload**, select **`dist/lambda-ingest.zip`** from your machine, then **Save**.

6. After upload completes, open **Runtime settings** → **Edit** and set:
   - **Handler:** `pipeline/lambda-handler.handler`  
     (This is the file `pipeline/lambda-handler.js` and the exported function named `handler`.)

7. Confirm **Runtime** is a current **Node.js** version (18.x, 20.x, or 24.x are all fine for this code).

8. Choose **Deploy** (or save) if the console prompts you to deploy after changing handler or code.

---

## Part C — Configure environment and test

1. Open the **Configuration** tab → **Environment variables** → **Edit**. Add what you need, for example:
   - **Dry-run (no Salesforce):** `INGEST_DRY_RUN` = `true`  
     Optional: `EMAIL_MEMORY_DIR` = `/var/task/fixtures/email-history-memory` (path inside the zip) and `EMAIL_MEMORY_WINDOW_DAYS` = `500` so memory matches local dry-run tests.
   - **Live Salesforce:** leave `INGEST_DRY_RUN` unset or `false`, and set `SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY` (PEM, with `\n` for newlines if stored in one line), plus any other variables your `pipeline/lib/salesforce-jwt.cjs` flow expects.

2. Under **Configuration** → **General configuration** → **Edit**, set a **Timeout** high enough for Salesforce (for example **30 seconds** or more) and memory (for example **256 MB**) as needed.

3. Open the **Test** tab, create a new test event, **JSON** body example for dry-run with packaged fixtures:

   ```json
   {
     "dryRun": true,
     "memoryDir": "/var/task/fixtures/email-history-memory",
     "memoryDays": 500
   }
   ```

4. Run **Test** and check **Execution result** and **CloudWatch Logs** for errors.

`/var/task` is where Lambda mounts your zip; folders `pipeline` and `fixtures` from the archive appear under `/var/task/pipeline` and `/var/task/fixtures`.

---

## Part D — Optional: schedule with EventBridge

1. In Lambda, **Add trigger** → **EventBridge (CloudWatch Events)**.
2. Create a new rule with a **schedule expression** (cron) or use an existing rule.
3. Allow EventBridge to invoke the function when prompted.

---

## Updating after code changes

Run `npm run package:lambda` again, then in Lambda **Upload** the new **`dist/lambda-ingest.zip`** and **Deploy**.
