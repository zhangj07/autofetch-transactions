// Called by BC right before it pushes an updated institutions list, so
// BC can refresh its own cached tokens (Isolated Storage) from whatever
// Key Vault ACTUALLY has -- including anything TokenRotationMulti wrote
// since BC's cache was last updated.
//
// Without this, BC's local Isolated Storage copy can go stale the
// moment a rotation runs (rotation writes straight to Key Vault; it has
// no way to reach into BC's Isolated Storage). If BC then pushes its own
// stale cached token for an UNRELATED reason (e.g. adding a different
// institution triggers a full-array push), it would silently overwrite
// Key Vault's fresh rotated token with the old dead one. Pulling live
// here, right before every push, closes that gap.
const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');

const keyVaultUrl = process.env.KEY_VAULT_URL;
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

const INSTITUTIONS_SECRET = process.env.PLAID_INSTITUTIONS_SECRET || 'plaid-institutions';

app.http('getInstitutions', {
    methods: ['GET'],
    authLevel: 'function',
    handler: async (request, context) => {
        try {
            let institutions = [];
            try {
                const secret = await secretClient.getSecret(INSTITUTIONS_SECRET);
                institutions = JSON.parse(secret.value);
            } catch (e) {
                // Secret doesn't exist yet -- nothing has ever been synced.
                institutions = [];
            }

            return { status: 200, jsonBody: { institutions } };
        } catch (err) {
            context.error(err);
            return { status: 500, jsonBody: { error: 'Failed to read institutions from Key Vault' } };
        }
    },
});
