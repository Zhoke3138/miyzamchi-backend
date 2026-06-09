const sdk = require('@superdoc-dev/sdk');
sdk.getToolCatalog().then(tools => {
    const googleTools = tools.map(t => ({
        name: t.name,
        description: t.description || t.schema.description,
        parameters: t.schema
    }));
    console.log(JSON.stringify(googleTools[0], null, 2));
}).catch(console.error);
