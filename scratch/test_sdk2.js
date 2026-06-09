const sdk = require('@superdoc-dev/sdk');
console.log(sdk.getSystemPrompt());
sdk.getToolCatalog().then(catalog => console.log(JSON.stringify(catalog, null, 2))).catch(console.error);
