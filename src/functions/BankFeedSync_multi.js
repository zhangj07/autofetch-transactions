// ============================================================
// BankFeedSync.js — Azure Function: Bank Feed Integration (MULTI-INSTITUTION)
// ============================================================
// WHAT CHANGED FOR MULTI-INSTITUTION:
//   * Instead of ONE access token, the function reads a JSON list of
//     institutions from a single Key Vault secret. Each entry is:
//        { "name": "NorthstarBank", "accessToken": "access-..." }
//   * It LOOPS every institution and runs the existing per-account
//     logic for each one.
//   * Each institution has its OWN cursor row in Table Storage
//     (RowKey = institution name) — cursors are tied to one token, so
//     they must not be shared across institutions.
//   * CSVs are written into a PER-INSTITUTION subfolder:
//        pending/<InstitutionName>/bankfeed-<Account>-<mask>-<ts>.csv
//   * The email report groups results by institution, then by account.
//   * BCImportCheck scans every institution subfolder under pending/.
// ============================================================

const { app } = require('@azure/functions');
const fetch = require('node-fetch');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables');
const { EmailClient } = require('@azure/communication-email');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const PLAID_CLIENT_ID = process.env.PLAID_TEST_CLIENTID;
const PLAID_SECRET    = process.env.PLAID_TEST_SECRET;
const PLAID_BASE_URL = process.env.PLAID_ENV === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';

// --- Institution list is read LIVE from Key Vault on every run. ---
// It is a single Key Vault secret whose VALUE is a JSON array:
//   [ { "name": "NorthstarBank", "accessToken": "access-sandbox-..." },
//     { "name": "BMO",           "accessToken": "access-sandbox-..." } ]
// Reading it live (not from an env var) means a token rotated into the
// JSON is picked up on the very next run with no restart.
const KEY_VAULT_URL          = process.env.KEY_VAULT_URL;                                  // https://yourvault.vault.azure.net
const INSTITUTIONS_SECRET    = process.env.PLAID_INSTITUTIONS_SECRET || 'plaid-institutions';

const BLOB_CONNECTION_STRING = process.env.BLOB_CONNECTION_STRING;
const BLOB_CONTAINER_NAME    = process.env.BLOB_CONTAINER_NAME;

const TABLE_NAME    = 'BankFeedCursor';
const PARTITION_KEY = 'BankFeed';
// NOTE: RowKey is now the institution name (one cursor row per institution),
// so there is no single ROW_KEY constant any more.

// ---- Email settings ----
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const EMAIL_FROM            = process.env.ALERT_EMAIL_FROM;
const EMAIL_TO              = process.env.ALERT_EMAIL_TO;
const SEND_SUCCESS_EMAIL    = process.env.NOTIFY_ON_SUCCESS !== 'false';

// ---- BC import checker settings ----
const STALE_HOURS         = Number(process.env.STALE_HOURS || 3);
const BC_NOTIFY_ALL_CLEAR = process.env.BC_NOTIFY_ALL_CLEAR === 'true';


// ============================================================
// Email helper — only job is to send an email. Never throws.
// ============================================================
async function sendEmail(subject, message, context) {
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
        await poller.pollUntilDone();
        context.log('Notification email sent.');
    } catch (emailError) {
        context.log('Could not send email: ' + emailError.message);
    }
}


// ============================================================
// Key Vault: LIVE institution-list read
// ============================================================
let _secretClient = null;
function getSecretClient() {
    if (!_secretClient) {
        _secretClient = new SecretClient(KEY_VAULT_URL, new DefaultAzureCredential());
    }
    return _secretClient;
}

// Reads the institution list from a single Key Vault secret and parses
// the JSON. Returns an array of { name, accessToken }. Throws a clear,
// tagged error if the secret is missing or malformed.
async function getInstitutions(context) {
    let raw;
    try {
        const secret = await getSecretClient().getSecret(INSTITUTIONS_SECRET);
        raw = secret.value;
    } catch (err) {
        const e = new Error('Could not read the institutions secret "' + INSTITUTIONS_SECRET + '" from Key Vault: ' + err.message);
        e.reason = 'INSTITUTIONS_SECRET_MISSING';
        throw e;
    }

    let list;
    try {
        list = JSON.parse(raw);
    } catch (err) {
        const e = new Error('The institutions secret is not valid JSON.');
        e.reason = 'INSTITUTIONS_JSON_INVALID';
        throw e;
    }

    if (!Array.isArray(list) || list.length === 0) {
        const e = new Error('The institutions secret must be a non-empty JSON array of { name, accessToken }.');
        e.reason = 'INSTITUTIONS_EMPTY';
        throw e;
    }

    // Basic shape validation + fingerprint log (never logs the full token).
    for (const inst of list) {
        if (!inst.name || !inst.accessToken) {
            const e = new Error('Every institution entry needs a "name" and an "accessToken".');
            e.reason = 'INSTITUTIONS_SHAPE';
            throw e;
        }
        context.log(`Institution loaded: ${inst.name} (token ...${String(inst.accessToken).slice(-6)})`);
    }

    return list;
}


// ============================================================
// Storage + Plaid helpers
// ============================================================
function getTableClient() {
    return TableClient.fromConnectionString(BLOB_CONNECTION_STRING, TABLE_NAME);
}

// Per-institution cursor read. RowKey = institution name.
async function readCursor(institutionName, context) {
    const tableClient = getTableClient();
    try {
        const entity = await tableClient.getEntity(PARTITION_KEY, institutionName);
        return entity.cursorValue || null;
    } catch (err) {
        const statusCode = err.statusCode ?? err.response?.status;
        const code       = err.code ?? err.errorCode;

        if (code === 'TableNotFound' || (statusCode === 404 && /table.*not.*found/i.test(err.message || ''))) {
            const e = new Error('The BankFeedCursor table is missing.');
            e.reason = 'TableNotFound';
            throw e;
        }
        if (statusCode === 404) {
            context.log(`No cursor yet for ${institutionName} — treating as first run.`);
            return null;
        }
        throw err;
    }
}

// Per-institution cursor save. RowKey = institution name.
async function saveCursor(institutionName, cursor) {
    const tableClient = getTableClient();
    await tableClient.upsertEntity({
        partitionKey: PARTITION_KEY,
        rowKey: institutionName,
        cursorValue: cursor
    });
}

// Single Plaid POST helper. Both the transactions and accounts calls
// share the same auth body, the same error handling, and the same
// error_code tagging — so that logic lives here once.
async function plaidPost(path, extraBody) {
    const body = {
        client_id:    PLAID_CLIENT_ID,
        secret:       PLAID_SECRET,
        ...extraBody
    };

    const response = await fetch(`${PLAID_BASE_URL}${path}`, {
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
    return await response.json();
}

async function fetchTransactions(cursor, accessToken) {
    const extra = { access_token: accessToken };
    if (cursor) extra.cursor = cursor;
    return await plaidPost('/transactions/sync', extra);
}

async function fetchAccounts(accessToken) {
    const data = await plaidPost('/accounts/get', { access_token: accessToken });
    return data.accounts;
}

// Build a filename-safe label like "Checking-1234" from account metadata.
function buildAccountLabel(account) {
    const name = account?.name || account?.official_name || 'Account';
    const mask = account?.mask || 'unknown';
    const safeName = name.replace(/[^a-zA-Z0-9]+/g, '');
    return `${safeName}-${mask}`;
}

// Make an institution name safe to use as a blob folder segment.
function safeInstitutionFolder(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]+/g, '');
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

// Uploads into pending/<InstitutionFolder>/<fileName>.
async function uploadToBlob(csv, institutionFolder, fileName, context) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
    const containerClient   = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
    const blobName          = `pending/${institutionFolder}/${fileName}`;
    const blockBlobClient   = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(csv, Buffer.byteLength(csv), {
        overwrite: true,
        blobHTTPHeaders: { blobContentType: 'text/csv' }
    });
    context.log('CSV uploaded: ' + blobName);
    return blobName;
}


// ============================================================
// Turn an error's "reason" note into a plain-English message.
// ============================================================
function explainError(err) {
    if (err.reason === 'ITEM_LOGIN_REQUIRED')
        return 'A bank connection expired. Go to the Plaid Dashboard -> Launch Link to reconnect, then update that institution\'s token in the Key Vault institutions secret.';
    if (err.reason === 'INVALID_ACCESS_TOKEN')
        return 'An access token is wrong or missing. Check the institutions JSON in Key Vault.';
    if (err.reason === 'INVALID_API_KEYS')
        return 'The Plaid client ID or secret is wrong. Check the environment variables.';
    if (err.reason === 'TableNotFound')
        return 'The BankFeedCursor table was deleted. Recreate it in Azure Portal -> Storage account -> Tables.';
    // All institutions-secret problems point the operator to the same place:
    // the Key Vault institutions secret. The specific error message carries
    // the detail (missing / not JSON / empty / bad shape).
    if (String(err.reason || '').startsWith('INSTITUTIONS_'))
        return 'There is a problem with the Key Vault institutions secret "' + INSTITUTIONS_SECRET + '": ' + err.message;
    return 'Something unexpected went wrong: ' + err.message;
}


// ============================================================
// Build a tidy report grouped by institution, then by account.
// `institutions` is an array of:
//   { name, status, count, error?, accounts: [ {label, accountId, count} ] }
// ============================================================
function buildReport({ status, totalCount, errorMessage, institutions, context }) {
    const tz  = 'America/Toronto';
    const now = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: tz });
    const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });

    const ranBy      = process.env.WEBSITE_SITE_NAME || 'BankFeedSync function';
    const invocation = context.invocationId;

    const lines = [
        `Overall status:     ${status}`,
        `Date:               ${date}`,
        `Time:               ${time} (Toronto)`,
        `Ran by:             ${ranBy}`,
        `Run ID:             ${invocation}`,
        `Total transactions: ${totalCount}`
    ];

    if (institutions && institutions.length > 0) {
        for (const inst of institutions) {
            lines.push('');
            lines.push(`Institution: ${inst.name}`);
            lines.push(`  Status:       ${inst.status}`);
            lines.push(`  Transactions: ${inst.count}`);
            if (inst.error)
                lines.push(`  Error:        ${inst.error}`);
            if (inst.accounts && inst.accounts.length > 0) {
                for (const acct of inst.accounts) {
                    lines.push(`    - ${acct.label}: ${acct.count} transaction(s)`);
                }
            }
        }
    }

    if (errorMessage) {
        lines.push('');
        lines.push(`Error: ${errorMessage}`);
    }

    return lines.join('\n');
}


// ============================================================
// Sync ONE institution. Returns a per-institution result object.
// Isolated in its own function so one institution failing does not
// stop the others (the main loop catches per-institution errors).
// ============================================================
async function syncInstitution(inst, context) {
    const result = { name: inst.name, status: 'SUCCESS', count: 0, accounts: [] };
    const folder = safeInstitutionFolder(inst.name);

    // Per-institution cursor.
    let cursor = await readCursor(inst.name, context);

    // Fetch all new transactions for this institution.
    let allTransactions = [];
    let hasMore = true;
    while (hasMore) {
        const response = await fetchTransactions(cursor, inst.accessToken);
        const settled  = response.added.filter(txn => txn.pending === false);
        allTransactions.push(...settled);
        cursor  = response.next_cursor;
        hasMore = response.has_more;
    }

    result.count = allTransactions.length;
    context.log(`[${inst.name}] Found ${result.count} new transaction(s).`);

    if (result.count === 0) {
        // Nothing new — still advance this institution's cursor.
        await saveCursor(inst.name, cursor);
        return result;
    }

    // Account metadata for readable labels.
    const accounts = await fetchAccounts(inst.accessToken);
    const accountLabels = {};
    for (const account of accounts) {
        const label = buildAccountLabel(account);
        accountLabels[account.account_id] = label;
        context.log(`[${inst.name}] Account found: ${label} (account_id: ${account.account_id})`);
    }

    // Group by account.
    const transactionsByAccount = {};
    for (const txn of allTransactions) {
        if (!transactionsByAccount[txn.account_id]) transactionsByAccount[txn.account_id] = [];
        transactionsByAccount[txn.account_id].push(txn);
    }
    context.log(`[${inst.name}] Transactions span ${Object.keys(transactionsByAccount).length} account(s).`);

    // One CSV per account, into this institution's subfolder.
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    for (const accountId of Object.keys(transactionsByAccount)) {
        const label = accountLabels[accountId] || accountId;
        const txns  = transactionsByAccount[accountId];

        context.log(`[${inst.name}] Writing CSV for account: ${label} — ${txns.length} transaction(s).`);
        const csv      = convertToCSV(txns);
        const fileName = `bankfeed-${label}-${timestamp}.csv`;
        await uploadToBlob(csv, folder, fileName, context);

        result.accounts.push({ accountId, label, count: txns.length });
    }

    // Advance the cursor only after all CSVs for this institution are written.
    await saveCursor(inst.name, cursor);

    return result;
}


// ============================================================
// MAIN TIMER FUNCTION: BankFeedSync
// Loops every institution; one institution's failure is recorded but
// does not stop the rest. Sends one combined report at the end.
// ============================================================
// Shared logic -- called by both the timer and the manual HTTP endpoint.
async function runBankFeedSync(context) {
    let totalCount = 0;
    const instResults = [];
    let hadFailure = false;

    try {
        const institutions = await getInstitutions(context);

        for (const inst of institutions) {
            try {
                const r = await syncInstitution(inst, context);
                totalCount += r.count;
                instResults.push(r);
            } catch (instErr) {
                hadFailure = true;
                const friendly = explainError(instErr);
                context.log(`[${inst.name}] FAILED: ${friendly}`);
                instResults.push({ name: inst.name, status: 'FAILED', count: 0, error: friendly, accounts: [] });
            }
        }

        const overall = hadFailure ? 'PARTIAL / FAILED' : 'SUCCESS';
        const report = buildReport({ status: overall, totalCount, institutions: instResults, context });
        context.log(report);

        if (hadFailure) {
            await sendEmail(`Bank feed sync: one or more institutions FAILED`, report, context);
        } else if (SEND_SUCCESS_EMAIL) {
            await sendEmail(`Bank feed sync OK - ${totalCount} new transaction(s)`, report, context);
        }

        if (hadFailure && instResults.every(r => r.status === 'FAILED'))
            throw new Error('All institutions failed to sync. See report above.');

        return { status: overall, totalCount, institutions: instResults };

    } catch (error) {
        const friendly = explainError(error);
        const report = buildReport({ status: 'FAILED', totalCount, errorMessage: friendly, institutions: instResults, context });
        context.log(report);
        await sendEmail('Bank feed sync FAILED', report, context);
        throw error;
    }
}

app.timer('BankFeedSyncMulti', {
    schedule: process.env.BANK_FEED_SCHEDULE || '0 0 8 * * *',
    handler: async (myTimer, context) => {
        context.log('Bank feed sync started (multi-institution, timer: BankFeedSyncMulti).');
        await runBankFeedSync(context);
    }
});

// Manual on-demand run -- this is what the BC Developer Test Run page calls.
app.http('BankFeedSyncManualRun', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const result = await runBankFeedSync(context);
            // success reflects the REAL outcome, not just "didn't throw" --
            // runBankFeedSync can return normally with status 'PARTIAL / FAILED'
            // when some (not all) institutions failed.
            const success = result.status === 'SUCCESS';
            return { status: 200, jsonBody: { success, ...result } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { success: false, error: err.message } };
        }
    }
});


// ============================================================
// SECOND FUNCTION: BCImportCheck (multi-institution aware)
// Scans EVERY institution subfolder under pending/ for files that BC
// hasn't imported (i.e. hasn't moved to processed/) within STALE_HOURS.
// ============================================================
async function findStalePendingFiles(context) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
    const containerClient   = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

    const cutoff = Date.now() - (STALE_HOURS * 60 * 60 * 1000);
    const stale  = [];

    // prefix 'pending/' now spans all institution subfolders, e.g.
    //   pending/NorthstarBank/bankfeed-....csv
    //   pending/BMO/bankfeed-....csv
    for await (const blob of containerClient.listBlobsFlat({ prefix: 'pending/' })) {
        if (blob.name.endsWith('/')) continue;      // skip folder placeholders
        if (!blob.name.endsWith('.csv')) continue;  // only count CSVs

        const created = blob.properties.createdOn || blob.properties.lastModified;
        if (created && created.getTime() < cutoff) {
            const ageHours = ((Date.now() - created.getTime()) / 3600000).toFixed(1);
            stale.push({ name: blob.name, ageHours });
        }
    }

    context.log(`pending/ check: ${stale.length} file(s) older than ${STALE_HOURS}h across all institutions.`);
    return stale;
}

async function runBCImportCheck(context) {
    context.log('BC import check started.');
    try {
        const stale = await findStalePendingFiles(context);

        if (stale.length > 0) {
            const fileList = stale.map(f => `  - ${f.name} (waiting ${f.ageHours}h)`).join('\n');
            const message =
                `Business Central has NOT imported the following file(s).\n` +
                `They have been sitting in a pending/<institution>/ folder for over ${STALE_HOURS} hour(s):\n\n` +
                `${fileList}\n\n` +
                `LIKELY CAUSE: the BC job queue is stopped, disabled, or erroring.\n` +
                `ACTION: In Business Central, open the Bank Feed setup page and check the ` +
                `job queue entry and run log. Restart the job queue entry if it is on hold.`;

            context.log('BC import check: stuck files found.');
            await sendEmail('Bank feed: BC import STUCK', message, context);

        } else if (BC_NOTIFY_ALL_CLEAR) {
            await sendEmail(
                'Bank feed: BC import OK',
                `All files imported by Business Central. Nothing older than ${STALE_HOURS}h in any pending/<institution>/ folder.`,
                context
            );
        }

        return { staleCount: stale.length, staleFiles: stale };

    } catch (error) {
        context.log('BC import check failed: ' + error.message);
        await sendEmail(
            'Bank feed: BC import CHECK FAILED',
            `The pending-folder check could not run: ${error.message}`,
            context
        );
        throw error;
    }
}

app.timer('BCImportCheckMulti', {
    schedule: process.env.BC_CHECK_SCHEDULE || '0 0 13 * * *',
    handler: async (myTimer, context) => {
        await runBCImportCheck(context);
    }
});

// Manual on-demand run -- what the BC Developer Test Run page calls.
app.http('BCImportCheckManualRun', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const result = await runBCImportCheck(context);
            return { status: 200, jsonBody: { success: true, ...result } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { success: false, error: err.message } };
        }
    }
});
