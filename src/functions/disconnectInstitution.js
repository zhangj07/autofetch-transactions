// Called by BC right before it wipes a Bank Connection's local token.
// Cleans up the TWO things that otherwise silently linger after a
// connection is deleted:
//
//   1. The per-institution cursor row in Table Storage (RowKey =
//      institution name). BankFeedSyncMulti keys its cursor purely by
//      institution NAME, not by Item ID -- so if the same institution
//      is reconnected later, it gets a brand-new Plaid Item + access
//      token, but the OLD cursor is still sitting there under that same
//      name and would be fed to the new Item. A cursor is scoped to the
//      specific Item it came from, so this mismatch is exactly the kind
//      of bug that surfaces much later, quietly, on reconnect.
//
//   2. The Plaid Item itself, via /item/remove -- good hygiene
//      regardless of the cursor issue, so nothing stays active on
//      Plaid's side for a connection BC no longer knows about.
//
// This must be called BEFORE the access token is wiped locally, since
// step 2 needs that token to identify which Item to remove.
const { app } = require('@azure/functions');
const fetch = require('node-fetch');
const { TableClient } = require('@azure/data-tables');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const PLAID_CLIENT_ID = process.env.PLAID_TEST_CLIENTID;
const PLAID_SECRET    = process.env.PLAID_TEST_SECRET;
const PLAID_BASE_URL  = 'https://sandbox.plaid.com'; // Change to production.plaid.com for live

const BLOB_CONNECTION_STRING = process.env.BLOB_CONNECTION_STRING;
const TABLE_NAME    = 'BankFeedCursor'; // Must match BankFeedSync_multi.js exactly.
const PARTITION_KEY = 'BankFeed';       // Must match BankFeedSync_multi.js exactly.

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

function getTableClient() {
    return TableClient.fromConnectionString(BLOB_CONNECTION_STRING, TABLE_NAME);
}

async function deleteCursor(institutionName, context) {
    const tableClient = getTableClient();
    try {
        await tableClient.deleteEntity(PARTITION_KEY, institutionName);
        context.log(`Deleted cursor row for "${institutionName}".`);
        return true;
    } catch (e) {
        if (e.statusCode === 404) {
            // No cursor existed -- e.g. it was never synced. Not an error.
            context.log(`No cursor row existed for "${institutionName}" -- nothing to delete.`);
            return true;
        }
        context.log(`Failed to delete cursor for "${institutionName}": ${e.message}`);
        return false;
    }
}

async function removePlaidItem(accessToken, context) {
    try {
        const body = { client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: accessToken };
        const res = await fetch(`${PLAID_BASE_URL}/item/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
            // Not fatal -- the token may already be invalid/removed on
            // Plaid's side (e.g. a prior rotation or manual removal).
            // Cursor cleanup above is the more important half; log and continue.
            context.log(`Plaid /item/remove failed (continuing anyway): ${text}`);
            return false;
        }
        context.log('Plaid Item removed successfully.');
        return true;
    } catch (e) {
        context.log(`Plaid /item/remove request failed: ${e.message}`);
        return false;
    }
}

app.http('disconnectInstitution', {
    methods: ['POST'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const institutionName = body?.institutionName;
            const accessToken = body?.accessToken;

            if (!institutionName) {
                return { status: 400, jsonBody: { error: 'Missing institutionName' } };
            }

            const cursorDeleted = await deleteCursor(institutionName, context);

            let itemRemoved = null;
            if (accessToken) {
                itemRemoved = await removePlaidItem(accessToken, context);
            }

            return {
                status: 200,
                jsonBody: { success: true, cursorDeleted, itemRemoved },
            };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to disconnect institution' } };
        }
    },
});
