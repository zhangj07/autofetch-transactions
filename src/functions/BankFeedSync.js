// ============================================================
// BankFeedSync.js — Azure Function: Bank Feed Integration
// ============================================================
const { app } = require('@azure/functions');
const fetch = require('node-fetch');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables');
const { EmailClient } = require('@azure/communication-email');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const PLAID_CLIENT_ID    = process.env.PLAID_TEST_CLIENTID;
const PLAID_SECRET       = process.env.PLAID_TEST_SECRET;
const PLAID_BASE_URL     = 'https://sandbox.plaid.com'; // Change to production.plaid.com for live

// --- Access token is now read LIVE from Key Vault on every run (see getAccessToken). ---
// It is intentionally NOT read from an env var. An env var (process.env.*) is a frozen
// snapshot taken when the process starts, so it would keep serving the OLD token after a
// rotation. Reading Key Vault at run time means the sync always picks up the current token,
// including one just written by the rotation function.
const KEY_VAULT_URL            = process.env.KEY_VAULT_URL;                        // e.g. https://yourvault.vault.azure.net
const ACCESS_TOKEN_SECRET_NAME = process.env.PLAID_ACCESS_TOKEN || 'plaid-test-access-token';

const BLOB_CONNECTION_STRING = process.env.BLOB_CONNECTION_STRING;
const BLOB_CONTAINER_NAME    = process.env.BLOB_CONTAINER_NAME;

const TABLE_NAME    = 'BankFeedCursor';
const PARTITION_KEY = 'BankFeed';
const ROW_KEY       = 'Cursor';

// ---- Email settings (set these in the Function App, not in code) ----
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING; // from your Communication Services resource
const EMAIL_FROM            = process.env.ALERT_EMAIL_FROM;      // e.g. donotreply@xxxx.azurecomm.net
const EMAIL_TO              = process.env.ALERT_EMAIL_TO;        // your email address
const SEND_SUCCESS_EMAIL    = process.env.NOTIFY_ON_SUCCESS !== 'false'; // on unless you set it to "false"

// ---- BC import checker settings ----
// How many hours a file can sit in pending/ before we assume BC failed to import it.
// Set this LONGER than your BC job queue interval so you don't get false alarms.
const STALE_HOURS         = Number(process.env.STALE_HOURS || 3);
// Email even when everything is fine ("all clear")? Off by default to avoid daily noise.
const BC_NOTIFY_ALL_CLEAR = process.env.BC_NOTIFY_ALL_CLEAR === 'true';


// ============================================================
// STEP 1: One tiny function whose only job is to send an email.
// ============================================================
async function sendEmail(subject, message, context) {
    // If email isn't set up yet, just skip it. Don't crash the function.
    if (!ACS_CONNECTION_STRING || !EMAIL_FROM || !EMAIL_TO) {
        context.log('Email not configured — skipping notification.');
        return;
    }

    try {
        const client = new EmailClient(ACS_CONNECTION_STRING);
        const poller = await client.beginSend({
            senderAddress: EMAIL_FROM,
            recipients: { to: [{ address: EMAIL_TO }] },
            content: { subject: subject, plainText: message }
        });
        await poller.pollUntilDone(); // wait until Azure confirms it's sending
        context.log('Notification email sent.');
    } catch (emailError) {
        // If the email itself fails, just log it. Never let it crash the real job.
        context.log('Could not send email: ' + emailError.message);
    }
}


// ============================================================
// Key Vault: LIVE access-token read
// ============================================================
// The SecretClient is created once (it's just a reusable client object — creating it does
// NOT fetch anything). The getSecret() CALL below runs on every sync and goes out to Key
// Vault each time, so it always returns the current version of the token. This is the whole
// point: after the rotation function writes a new token, the very next sync reads it here
// with no restart, no waiting, and no stale cache.
let _secretClient = null;
function getSecretClient() {
    if (!_secretClient) {
        _secretClient = new SecretClient(KEY_VAULT_URL, new DefaultAzureCredential());
    }
    return _secretClient;
}

async function getAccessToken(context) {
    const secret = await getSecretClient().getSecret(ACCESS_TOKEN_SECRET_NAME);
    // Fingerprint (last 6 chars) so you can confirm in the logs which token was actually used.
    // After a rotation this value should change on the next run.
    context.log('Access token read live from Key Vault. Fingerprint: ...' + (secret.value || '').slice(-6));
    return secret.value;
}


// ============================================================
// Storage + Plaid helpers
// ============================================================
function getTableClient() {
    return TableClient.fromConnectionString(BLOB_CONNECTION_STRING, TABLE_NAME);
}

async function readCursor(context) {
    const tableClient = getTableClient();
    try {
        const entity = await tableClient.getEntity(PARTITION_KEY, ROW_KEY);
        return entity.cursorValue || null;
    } catch (err) {
        const statusCode = err.statusCode ?? err.response?.status;
        const code       = err.code ?? err.errorCode;

        if (code === 'TableNotFound' || (statusCode === 404 && /table.*not.*found/i.test(err.message || ''))) {
            const e = new Error('The BankFeedCursor table is missing.');
            e.reason = 'TableNotFound'; // <-- sticky note: tells the catch block what went wrong
            throw e;
        }
        if (statusCode === 404) {
            context.log('No cursor yet — treating as first run.');
            return null;
        }
        throw err;
    }
}

async function saveCursor(cursor) {
    const tableClient = getTableClient();
    await tableClient.upsertEntity({
        partitionKey: PARTITION_KEY,
        rowKey: ROW_KEY,
        cursorValue: cursor
    });
}

async function fetchTransactions(cursor, accessToken) {
    const body = {
        client_id:    PLAID_CLIENT_ID,
        secret:       PLAID_SECRET,
        access_token: accessToken
    };
    if (cursor) body.cursor = cursor;

    const response = await fetch(`${PLAID_BASE_URL}/transactions/sync`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();

        // Plaid tells us what went wrong in a field called "error_code".
        // We grab it and stick it on the error as a note for later.
        const e = new Error('Plaid API error: ' + errorText);
        try {
            e.reason = JSON.parse(errorText).error_code; // e.g. "ITEM_LOGIN_REQUIRED"
        } catch (_) {}
        throw e;
    }
    return await response.json();
}

// Fetch account metadata (name/mask) for every account under this Item.
// Used to give each account its own readable CSV name and its own email status line.
async function fetchAccounts(accessToken) {
    const body = {
        client_id:    PLAID_CLIENT_ID,
        secret:       PLAID_SECRET,
        access_token: accessToken
    };

    const response = await fetch(`${PLAID_BASE_URL}/accounts/get`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
    });

    if (!response.ok) {
        const errorText = await response.text();
        const e = new Error('Plaid API error: ' + errorText);
        try {
            e.reason = JSON.parse(errorText).error_code;
        } catch (_) {}
        throw e;
    }
    const data = await response.json();
    return data.accounts;
}

// Build a filename-safe label like "Checking-1234" from account metadata.
function buildAccountLabel(account) {
    const name = account?.name || account?.official_name || 'Account';
    const mask = account?.mask || 'unknown';
    const safeName = name.replace(/[^a-zA-Z0-9]+/g, '');
    return `${safeName}-${mask}`;
}

function convertToCSV(transactions) {
    const lines = ['col1,col2,col3,Date,Amount,Description'];
    for (const txn of transactions) {
        const amount = (txn.amount * -1).toFixed(2);
        let description = txn.merchant_name || txn.name || 'Unknown';
        if (description.includes(',')) description = `"${description}"`;
        lines.push(`,,,${txn.date},${amount},${description}`);
    }
    return lines.join('\r\n');
}

async function uploadToBlob(csv, fileName, context) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
    const containerClient   = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
    const blobName          = `pending/${fileName}`;
    const blockBlobClient   = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(csv, Buffer.byteLength(csv), {
        overwrite: true,
        blobHTTPHeaders: { blobContentType: 'text/csv' }
    });
    context.log('CSV uploaded: ' + blobName);
    return blobName;
}


// ============================================================
// STEP 2: Turn an error's "reason" note into a plain-English message.
// ============================================================
function explainError(err) {
    if (err.reason === 'ITEM_LOGIN_REQUIRED')
        return 'The bank connection expired. Go to the Plaid Dashboard -> Launch Link to reconnect, then update PLAID_ACCESS_TOKEN in Key Vault.';
    if (err.reason === 'INVALID_ACCESS_TOKEN')
        return 'The Plaid access token is wrong or missing. Check the PLAID-ACCESS-TOKEN secret in Key Vault.';
    if (err.reason === 'INVALID_API_KEYS')
        return 'The Plaid client ID or secret is wrong. Check the environment variables / Key Vault secrets.';
    if (err.reason === 'TableNotFound')
        return 'The BankFeedCursor table was deleted. Recreate it in Azure Portal -> Storage account -> Tables.';
    return 'Something unexpected went wrong: ' + err.message; // catch-all
}


// ============================================================
// STEP 2b: Build a tidy report used for BOTH the email and the log.
// Same fields every time, so the format is predictable.
// ============================================================
// `accounts` (optional) is an array of per-account results:
//   { accountId, label, status, count }
// When provided, the report shows one status block PER bank account.
// When omitted, it falls back to the original single-block report.
function buildReport({ status, count, errorMessage, accessToken, accounts, context }) {
    const tz  = 'America/Toronto';                 // shows Toronto time, handles EST/EDT
    const now = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: tz });            // 2026-06-29
    const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }); // 15:50:01

    const ranBy      = process.env.WEBSITE_SITE_NAME || 'BankFeedSync function';
    const account    = accessToken ? '...' + accessToken.slice(-6) : 'unknown';
    const invocation = context.invocationId;

    // Shared header shown once at the top of every report.
    const header = [
        `Overall status: ${status}`,
        `Date:           ${date}`,
        `Time:           ${time} (Toronto)`,
        `Ran by:         ${ranBy}`,
        `Account token:  ${account}`,
        `Run ID:         ${invocation}`,
        `Total transactions: ${count}`
    ];

    const lines = [...header];

    // Per-account breakdown, one block per bank account.
    if (accounts && accounts.length > 0) {
        for (const acct of accounts) {
            lines.push('');
            lines.push(`Bank account: ${acct.label} (id: ${acct.accountId})`);
            lines.push(`  Status:        ${acct.status}`);
            lines.push(`  Transactions:  ${acct.count}`);
        }
    }

    if (errorMessage) {
        lines.push('');
        lines.push(`Error:          ${errorMessage}`);
    }

    return lines.join('\n');
}


// ============================================================
// STEP 3: The main job. Runs on the timer.
// ============================================================
app.timer('BankFeedSync', {
    schedule: process.env.BANK_FEED_SCHEDULE || '0 0 8 * * *',
    handler: async (myTimer, context) => {
        context.log('Bank feed sync started.');

        let count = 0;              // tracked out here so the failure email can report it too
        let accessToken = null;     // tracked out here so the failure report can show its fingerprint
        let accountResults = [];    // per-account status/count for the email breakdown

        try {
            // --- TEST HOOK (remove before production) ---
            // To test the failure email without breaking anything, set an app setting
            // TEST_FAIL_REASON in the Function App, e.g.
            //   TEST_FAIL_REASON = ITEM_LOGIN_REQUIRED   (or INVALID_ACCESS_TOKEN,
            //   INVALID_API_KEYS, TableNotFound, or any text for the generic message).
            // Delete the setting afterwards to go back to normal. No Plaid/storage changes.
            if (process.env.TEST_FAIL_REASON) {
                const e = new Error('Simulated failure for testing.');
                e.reason = process.env.TEST_FAIL_REASON;
                throw e;
            }

            // --- get the current token LIVE from Key Vault (not from a cached env var) ---
            accessToken = await getAccessToken(context);

            // --- do the actual work ---
            let cursor = await readCursor(context);

            let allTransactions = [];
            let hasMore = true;
            while (hasMore) {
                const response = await fetchTransactions(cursor, accessToken);
                const settled  = response.added.filter(txn => txn.pending === false);
                allTransactions.push(...settled);
                cursor  = response.next_cursor;
                hasMore = response.has_more;
            }

            count = allTransactions.length;
            context.log(`Found ${count} new transaction(s).`);

            if (count === 0) {
                // Nothing new for any account — just advance the cursor.
                await saveCursor(cursor);
            } else {
                // --- fetch account metadata so each account gets a readable label ---
                const accounts = await fetchAccounts(accessToken);
                const accountLabels = {}; // account_id -> readable label
                for (const account of accounts) {
                    const label = buildAccountLabel(account);
                    accountLabels[account.account_id] = label;
                    context.log(`Account found: ${label} (account_id: ${account.account_id})`);
                }

                // --- group transactions by account_id ---
                const transactionsByAccount = {};
                for (const txn of allTransactions) {
                    if (!transactionsByAccount[txn.account_id]) {
                        transactionsByAccount[txn.account_id] = [];
                    }
                    transactionsByAccount[txn.account_id].push(txn);
                }
                context.log(`Transactions span ${Object.keys(transactionsByAccount).length} account(s).`);

                // --- write ONE CSV per account ---
                const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
                for (const accountId of Object.keys(transactionsByAccount)) {
                    const label = accountLabels[accountId] || accountId;
                    const txns  = transactionsByAccount[accountId];

                    context.log(`Writing CSV for account: ${label} — ${txns.length} transaction(s).`);
                    const csv      = convertToCSV(txns);
                    const fileName = `bankfeed-${label}-${timestamp}.csv`;
                    await uploadToBlob(csv, fileName, context);

                    accountResults.push({
                        accountId,
                        label,
                        status: 'SUCCESS',
                        count: txns.length
                    });
                }

                // --- only advance the cursor after all account CSVs are written ---
                await saveCursor(cursor);
            }

            // --- it worked: build the report (with per-account breakdown), log it, email it ---
            const report = buildReport({ status: 'SUCCESS', count, accessToken, accounts: accountResults, context });
            context.log(report);
            if (SEND_SUCCESS_EMAIL) {
                await sendEmail(`Bank feed sync OK - ${count} new transaction(s)`, report, context);
            }

        } catch (error) {
            // --- it broke: same report, but with the error filled in ---
            const friendly = explainError(error);
            const report   = buildReport({ status: 'FAILED', count, errorMessage: friendly, accessToken, accounts: accountResults, context });
            context.log(report);
            await sendEmail('Bank feed sync FAILED', report, context);

            throw error; // re-throw so Azure still records the run as failed
        }
    }
});


// ============================================================
// STEP 4: BC import checker.
// A SECOND function. Runs a few hours after the sync and checks whether
// Business Central actually imported the files. It does this WITHOUT talking
// to BC at all: BC moves a file from pending/ to processed/ once it imports
// successfully, so a file still stuck in pending/ after a while means BC
// didn't pick it up (job queue stuck / disabled / erroring).
// ============================================================

// Find files in pending/ that are older than the stale threshold.
async function findStalePendingFiles(context) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
    const containerClient   = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

    const cutoff = Date.now() - (STALE_HOURS * 60 * 60 * 1000); // "too old" line in time
    const stale  = [];

    // List only the blobs under the pending/ folder.
    for await (const blob of containerClient.listBlobsFlat({ prefix: 'pending/' })) {
        // Skip the "folder" placeholder if one exists.
        if (blob.name === 'pending/') continue;

        const created = blob.properties.createdOn || blob.properties.lastModified;
        if (created && created.getTime() < cutoff) {
            const ageHours = ((Date.now() - created.getTime()) / 3600000).toFixed(1);
            stale.push({ name: blob.name, ageHours });
        }
    }

    context.log(`pending/ check: ${stale.length} file(s) older than ${STALE_HOURS}h.`);
    return stale;
}

app.timer('BCImportCheck', {
    // Default: 1pm Toronto, a few hours after the 8am sync. Override with BC_CHECK_SCHEDULE.
    schedule: process.env.BC_CHECK_SCHEDULE || '0 0 13 * * *',
    handler: async (myTimer, context) => {
        context.log('BC import check started.');

        try {
            const stale = await findStalePendingFiles(context);

            if (stale.length > 0) {
                // Something is stuck — build a list and email it.
                const fileList = stale.map(f => `  - ${f.name} (waiting ${f.ageHours}h)`).join('\n');
                const message =
                    `Business Central has NOT imported the following file(s).\n` +
                    `They have been sitting in the pending/ folder for over ${STALE_HOURS} hour(s):\n\n` +
                    `${fileList}\n\n` +
                    `LIKELY CAUSE: the BC job queue is stopped, disabled, or erroring.\n` +
                    `ACTION: In Business Central, open the Bank Feed setup page and check the ` +
                    `job queue entry and run log. Restart the job queue entry if it is on hold.`;

                context.log('BC import check: stuck files found.');
                await sendEmail('Bank feed: BC import STUCK', message, context);

            } else if (BC_NOTIFY_ALL_CLEAR) {
                // Everything imported. Only emails if you turned the all-clear on.
                await sendEmail(
                    'Bank feed: BC import OK',
                    `All files imported by Business Central. Nothing older than ${STALE_HOURS}h in pending/.`,
                    context
                );
            }

        } catch (error) {
            // If the CHECK itself fails (e.g. can't reach storage), tell someone.
            context.log('BC import check failed: ' + error.message);
            await sendEmail(
                'Bank feed: BC import CHECK FAILED',
                `The pending-folder check could not run: ${error.message}`,
                context
            );
            throw error;
        }
    }
});
