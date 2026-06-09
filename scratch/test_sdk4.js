const sdk = require('@superdoc-dev/sdk');
(async () => {
    try {
        const tools = await sdk.chooseTools({ provider: 'gemini' });
        console.log("Gemini tools:", JSON.stringify(tools, null, 2).substring(0, 500));
        const openaiTools = await sdk.chooseTools({ provider: 'openai' });
        console.log("OpenAI tools:", JSON.stringify(openaiTools, null, 2).substring(0, 500));
    } catch(e) { console.error(e); }
})();
