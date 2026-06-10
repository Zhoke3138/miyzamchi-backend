> ## Documentation Index
> Fetch the complete documentation index at: https://docs.superdoc.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# AI Agents

> Document tools that plug into any LLM provider: what they do and how they work

The SuperDoc SDK ships tool definitions that give LLMs structured access to document operations. They cover reading, searching, editing, formatting, lists, comments, tracked changes, and batched mutations. Pick a provider format, pass the tools to your model, dispatch the calls, and the SDK handles schema formatting, argument validation, and execution.

## Quick start

Install the SDK, create a client, open a document, and wire up an agentic loop.

<Tabs>
  <Tab title="Node.js">
    ```bash theme={null}
    npm install @superdoc-dev/sdk openai
    ```

    ```typescript theme={null}
    import { createSuperDocClient, chooseTools, dispatchSuperDocTool } from '@superdoc-dev/sdk';
    import OpenAI from 'openai';

    const client = createSuperDocClient();
    await client.connect();
    const doc = await client.open({ doc: './contract.docx' });

    const { tools } = await chooseTools({ provider: 'openai' });
    const openai = new OpenAI();

    const messages = [
      { role: 'system', content: 'You edit documents using the provided tools.' },
      { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
    ];

    while (true) {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages,
        tools,
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (!message.tool_calls?.length) break;

      for (const call of message.tool_calls) {
        const result = await dispatchSuperDocTool(
          doc,
          call.function.name,
          JSON.parse(call.function.arguments),
        );
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    await doc.save({ inPlace: true });
    await doc.close();
    await client.dispose();
    ```
  </Tab>

  <Tab title="Python">
    ```bash theme={null}
    pip install superdoc-sdk openai
    ```

    ```python theme={null}
    import json
    import openai
    from superdoc import SuperDocClient, choose_tools, dispatch_superdoc_tool

    client = SuperDocClient()
    client.connect()
    doc = client.open({"doc": "./contract.docx"})

    result = choose_tools({"provider": "openai"})
    tools = result["tools"]

    messages = [
        {"role": "system", "content": "You edit documents using the provided tools."},
        {"role": "user", "content": "Find the termination clause and rewrite it to allow 30-day notice."},
    ]

    while True:
        response = openai.chat.completions.create(
            model="gpt-5.4", messages=messages, tools=tools
        )
        message = response.choices[0].message
        messages.append(message)

        if not message.tool_calls:
            break

        for call in message.tool_calls:
            result = dispatch_superdoc_tool(
                doc, call.function.name, json.loads(call.function.arguments)
            )
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": json.dumps(result),
            })

    doc.save({"inPlace": True})
    doc.close({})
    client.dispose()
    ```
  </Tab>
</Tabs>

## Tool selection

`chooseTools()` returns provider-formatted tool definitions ready to pass to your LLM.

<Tabs>
  <Tab title="Node.js">
    ```typescript theme={null}
    import { chooseTools } from '@superdoc-dev/sdk';

    const { tools, meta } = await chooseTools({
      provider: 'openai',   // 'openai' | 'anthropic' | 'vercel' | 'generic'
    });
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from superdoc import choose_tools

    result = choose_tools({"provider": "openai"})
    tools = result["tools"]
    ```
  </Tab>
</Tabs>

The current SDK returns the full grouped intent tool set for the selected provider. Group filtering and meta-discovery are not part of the shipped public API here.

## Tool catalog

The generated catalog currently contains 9 grouped intent tools. Most tools use an `action` argument to select the underlying operation. Single-action tools like `superdoc_search` do not require `action`.

| Tool                     | Actions                                                                                                       | What it does                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `superdoc_get_content`   | `text`, `markdown`, `html`, `info`                                                                            | Read document content in different formats                         |
| `superdoc_search`        | *(single action)*                                                                                             | Find text or nodes and return handles or addresses for later edits |
| `superdoc_edit`          | `insert`, `replace`, `delete`, `undo`, `redo`                                                                 | Perform text edits and history actions                             |
| `superdoc_format`        | `inline`, `set_style`, `set_alignment`, `set_indentation`, `set_spacing`, `set_direction`, `set_flow_options` | Apply inline or paragraph formatting                               |
| `superdoc_create`        | `paragraph`, `heading`, `table`                                                                               | Create structural block elements                                   |
| `superdoc_list`          | `insert`, `create`, `detach`, `indent`, `outdent`, `set_level`, `set_type`                                    | Create and manipulate lists                                        |
| `superdoc_comment`       | `create`, `update`, `delete`, `get`, `list`                                                                   | Manage comment threads                                             |
| `superdoc_track_changes` | `list`, `decide`                                                                                              | Review and resolve tracked changes                                 |
| `superdoc_mutations`     | `preview`, `apply`                                                                                            | Execute multi-step atomic edits as a batch                         |

<Note>
  Built-in tools cover the core operations. For tables, images, hyperlinks, and anything else, [create custom tools](#creating-custom-tools) that call any `doc.*` operation today.
</Note>

## Dispatching tool calls

`dispatchSuperDocTool()` resolves a tool name to the correct SDK method, validates arguments, and executes the call against a bound document handle.

<Tabs>
  <Tab title="Node.js">
    ```typescript theme={null}
    import { dispatchSuperDocTool } from '@superdoc-dev/sdk';

    const result = await dispatchSuperDocTool(doc, toolName, args);
    ```
  </Tab>

  <Tab title="Python (sync)">
    ```python theme={null}
    from superdoc import dispatch_superdoc_tool

    result = dispatch_superdoc_tool(doc, tool_name, args)
    ```
  </Tab>

  <Tab title="Python (async)">
    ```python theme={null}
    from superdoc import dispatch_superdoc_tool_async

    result = await dispatch_superdoc_tool_async(doc, tool_name, args)
    ```
  </Tab>
</Tabs>

The dispatcher validates required parameters, checks that arguments are compatible, and throws descriptive errors the LLM can act on.

## System prompt

`getSystemPrompt()` returns a default prompt that teaches the model the tool workflow: targeting, search-before-edit, and common patterns. It's optional. You can use it as-is, extend it with your own instructions, or write a completely custom prompt.

```typescript theme={null}
import { getSystemPrompt } from '@superdoc-dev/sdk';

const systemPrompt = await getSystemPrompt();
```

## Provider formats

Each provider gets tool definitions in its native format.

<Tabs>
  <Tab title="OpenAI">
    ```typescript theme={null}
    const { tools } = await chooseTools({ provider: 'openai' });
    // [{ type: 'function', function: { name, description, parameters } }]
    ```
  </Tab>

  <Tab title="Anthropic">
    ```typescript theme={null}
    const { tools } = await chooseTools({ provider: 'anthropic' });
    // [{ name, description, input_schema }]
    ```
  </Tab>

  <Tab title="Vercel AI">
    ```typescript theme={null}
    const { tools } = await chooseTools({ provider: 'vercel' });
    // [{ type: 'function', function: { name, description, parameters } }]
    ```
  </Tab>

  <Tab title="Generic">
    ```typescript theme={null}
    const { tools } = await chooseTools({ provider: 'generic' });
    // [{ name, description, parameters, returns, metadata }]
    ```
  </Tab>
</Tabs>

## Creating custom tools

The built-in tools cover core editing operations. For advanced features like tables, images, hyperlinks, footnotes, and citations, create custom tools that call `doc.*` methods directly.

| Step                  | What you do                                        |
| --------------------- | -------------------------------------------------- |
| 1. Pick operations    | Browse `doc.*` to find the methods you need        |
| 2. Define the schema  | Write a function tool definition for your provider |
| 3. Write a dispatcher | Map tool actions to `doc.*` calls                  |
| 4. Merge and use      | Combine with SDK tools in your agentic loop        |

### Step 1: Pick your operations

Every `doc.*` namespace maps to a group of [Document API](/document-api/overview) operations:

```text theme={null}
doc.hyperlinks   → list, get, wrap, insert, patch, remove
doc.tables       → get, insertRow, deleteRow, mergeCells, ...
doc.images       → list, get, setSize, rotate, crop, ...
doc.footnotes    → list, get, create, delete, update, ...
doc.bookmarks    → list, get, create, delete, ...
```

### Step 2: Define the tool schema

Group related operations under a single tool using an `action` enum. This matches the pattern the built-in tools use.

```typescript theme={null}
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const hyperlinkTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'superdoc_hyperlink',
    description:
      'Create, read, update, or remove hyperlinks in the document.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'wrap', 'insert', 'patch', 'remove'],
        },
        target: {
          description: 'Target address from superdoc_search results.',
        },
        text: { type: 'string', description: 'Display text (insert only).' },
        href: { type: 'string', description: 'URL destination.' },
        tooltip: { type: 'string', description: 'Hover tooltip text.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
};
```

<Note>
  * Keep descriptions short. The model reads every tool definition on each turn.
  * Use `additionalProperties: false` to prevent hallucinated parameters.
  * Reference `superdoc_search` in descriptions so the model knows how to get targets.
</Note>

### Step 3: Write a dispatcher

Map each action to the corresponding `doc.*` call:

```typescript theme={null}
import { dispatchSuperDocTool } from '@superdoc-dev/sdk';

async function dispatchToolCall(doc, toolName, args) {
  // Built-in tools: delegate to the SDK
  if (toolName !== 'superdoc_hyperlink') {
    return dispatchSuperDocTool(doc, toolName, args);
  }

  // Custom tool: call doc.* directly
  const { action, target, text, href, tooltip } = args;

  switch (action) {
    case 'list':
      return doc.hyperlinks.list({});
    case 'get':
      return doc.hyperlinks.get({ target });
    case 'wrap':
      return doc.hyperlinks.wrap({
        target,
        link: { destination: { href }, ...(tooltip && { tooltip }) },
      });
    case 'insert':
      return doc.hyperlinks.insert({
        text,
        link: { destination: { href }, ...(tooltip && { tooltip }) },
        ...(target && { target }),
      });
    case 'patch':
      return doc.hyperlinks.patch({
        target,
        patch: { ...(href && { href }), ...(tooltip && { tooltip }) },
      });
    case 'remove':
      return doc.hyperlinks.remove({ target });
    default:
      throw new Error(`Unknown action: "${action}"`);
  }
}
```

### Step 4: Merge and use

Combine your custom tool with the SDK tools and use your dispatcher in the agentic loop:

```typescript theme={null}
const { tools: sdkTools } = await chooseTools({ provider: 'openai' });
const allTools = [...sdkTools, hyperlinkTool];

// In your agentic loop, use your dispatcher instead of dispatchSuperDocTool:
// OpenAI chat completions store the tool name on function.name.
const toolName = toolCall.function.name;
const result = await dispatchToolCall(doc, toolName, args);
```

### Extending the system prompt

For custom tools, append usage instructions to the SDK system prompt so the model knows how to use them:

```typescript theme={null}
const systemPrompt = await getSystemPrompt();

const customInstructions = `
## superdoc_hyperlink

Use this tool to manage hyperlinks. First use superdoc_search to find
text you want to link, then pass the handle as target to the wrap action.
`;

const fullPrompt = systemPrompt + '\n' + customInstructions;
```

## SDK functions

| Function                                | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| `chooseTools(input)`                    | Load grouped tool definitions for a provider        |
| `dispatchSuperDocTool(doc, name, args)` | Execute a tool call against a bound document handle |
| `listTools(provider)`                   | List all tool definitions for a provider            |
| `getToolCatalog()`                      | Load the full tool catalog with metadata            |
| `getSystemPrompt()`                     | Read the bundled system prompt for intent tools     |

## Related

* [How to use](/ai/agents/integrations): step-by-step integration guide with copy-pasteable code
* [Best practices](/ai/agents/best-practices): prompting, workflow tips, and tested prompt examples
* [Debugging](/ai/agents/debugging): troubleshoot tool call failures
* [SDKs](/document-engine/sdks): typed Node.js and Python wrappers
* [Document API](/document-api/overview): the operation set behind the tools


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.superdoc.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# How to use

> Build an AI agent that edits documents using SuperDoc LLM tools: complete, copy-pasteable examples

Wire up an LLM agent that reads and edits `.docx` files headlessly. Install the SDK, open a document, and run an agentic tool loop. Full working code below.

<Note>
  If you need real-time sync between the agent and a frontend editor, add [collaboration](/editor/collaboration/overview). The SDK client joins the same Yjs room as the frontend: edits appear live.
</Note>

## Prerequisites

* Node.js 18+
* `@superdoc-dev/sdk`
* An LLM provider API key (e.g., `OPENAI_API_KEY`)

## Step 1: Install

<Tabs>
  <Tab title="OpenAI">
    ```bash theme={null}
    npm install @superdoc-dev/sdk openai
    ```
  </Tab>

  <Tab title="Anthropic">
    ```bash theme={null}
    npm install @superdoc-dev/sdk @anthropic-ai/sdk
    ```
  </Tab>

  <Tab title="Vercel AI">
    ```bash theme={null}
    npm install @superdoc-dev/sdk ai @ai-sdk/openai
    ```
  </Tab>
</Tabs>

## Step 2: Open a document

Create an SDK client and open a `.docx` file. `client.open()` returns a document handle you'll pass to the dispatcher.

```typescript theme={null}
import { createSuperDocClient } from '@superdoc-dev/sdk';

const client = createSuperDocClient();
await client.connect();

const doc = await client.open({ doc: './contract.docx' });
```

## Step 3: Load tools and system prompt

Load the tool definitions for your provider and the default system prompt. Both can be cached: they don't change between requests.

<Tabs>
  <Tab title="OpenAI">
    ```typescript theme={null}
    import { chooseTools, getSystemPrompt } from '@superdoc-dev/sdk';

    const { tools } = await chooseTools({ provider: 'openai' });
    const systemPrompt = await getSystemPrompt();
    ```
  </Tab>

  <Tab title="Anthropic">
    ```typescript theme={null}
    import { chooseTools, getSystemPrompt } from '@superdoc-dev/sdk';

    const { tools } = await chooseTools({ provider: 'anthropic' });
    const systemPrompt = await getSystemPrompt();
    ```
  </Tab>

  <Tab title="Vercel AI">
    ```typescript theme={null}
    import { chooseTools, getSystemPrompt } from '@superdoc-dev/sdk';

    const { tools: sdkTools } = await chooseTools({ provider: 'vercel' });
    const systemPrompt = await getSystemPrompt();
    ```
  </Tab>
</Tabs>

## Step 4: Run the agent loop

The agent loop sends messages to the LLM, dispatches tool calls, feeds results back, and repeats until the model is done.

<Tabs>
  <Tab title="OpenAI">
    ```typescript theme={null}
    import OpenAI from 'openai';
    import { dispatchSuperDocTool } from '@superdoc-dev/sdk';

    const openai = new OpenAI(); // uses OPENAI_API_KEY env var

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
    ];

    while (true) {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages,
        tools,
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      // Stop when the model has no more tool calls
      if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
        console.log(choice.message.content);
        break;
      }

      // Execute each tool call and feed results back
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;

        try {
          const result = await dispatchSuperDocTool(
            doc,
            toolCall.function.name,
            JSON.parse(toolCall.function.arguments),
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (err: any) {
          // Return errors as tool results: the model will self-correct
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }
    }
    ```

    **What's happening:**

    1. The system prompt teaches the model how to use SuperDoc tools.
    2. The `while(true)` loop calls OpenAI, checks for tool calls, dispatches them via `dispatchSuperDocTool`, and feeds results back.
    3. When the model returns `finish_reason: 'stop'` (no more tool calls), the loop ends.
    4. Errors are caught and returned as tool results so the model can see what went wrong and retry.
  </Tab>

  <Tab title="Anthropic">
    ```typescript theme={null}
    import Anthropic from '@anthropic-ai/sdk';
    import { dispatchSuperDocTool } from '@superdoc-dev/sdk';

    const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env var

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
    ];

    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });

      messages.push({ role: 'assistant', content: response.content });

      // Stop when the model has no more tool calls
      if (response.stop_reason === 'end_turn' || !response.content.some((b) => b.type === 'tool_use')) {
        const textBlock = response.content.find((b) => b.type === 'text');
        console.log(textBlock?.text);
        break;
      }

      // Execute each tool call and feed results back
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        try {
          const result = await dispatchSuperDocTool(
            doc,
            block.name,
            block.input as Record<string, unknown>,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err: any) {
          // Return errors as tool results: the model will self-correct
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }
    ```

    **What's happening:**

    1. The system prompt is passed via the `system` parameter (not as a message).
    2. The loop calls Anthropic, checks for `tool_use` blocks, dispatches them, and collects `tool_result` blocks.
    3. Tool results are sent back as a `user` message with an array of `tool_result` blocks.
    4. When the model returns `stop_reason: 'end_turn'` (no more tool calls), the loop ends.
    5. Errors use `is_error: true` so the model knows the call failed.
  </Tab>

  <Tab title="Vercel AI">
    ```typescript theme={null}
    import { generateText, jsonSchema, stepCountIs } from 'ai';
    import { openai } from '@ai-sdk/openai';
    import { dispatchSuperDocTool } from '@superdoc-dev/sdk';

    // Convert SDK tool definitions into Vercel AI tool objects with execute functions
    const tools: Record<string, any> = {};
    for (const t of sdkTools as any[]) {
      const fn = t.function;
      tools[fn.name] = {
        description: fn.description,
        inputSchema: jsonSchema<Record<string, unknown>>(fn.parameters),
        execute: async (args: Record<string, unknown>) => {
          try {
            return await dispatchSuperDocTool(doc, fn.name, args);
          } catch (err: any) {
            return { error: err.message };
          }
        },
      };
    }

    // generateText handles the agent loop internally
    const { text } = await generateText({
      model: openai.chat('gpt-5.4'),
      system: systemPrompt,
      messages: [
        { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
      ],
      tools,
      stopWhen: stepCountIs(10),
    });

    console.log(text);
    ```

    **What's happening:**

    1. SDK tool definitions are converted into Vercel AI tool objects: each with an `execute` function that calls `dispatchSuperDocTool`.
    2. `generateText` handles the agent loop internally: it calls the model, executes tools, feeds results back, and repeats.
    3. `stopWhen: stepCountIs(10)` sets a max iteration guard.
    4. No manual `while(true)` loop needed: Vercel AI manages it for you.
  </Tab>
</Tabs>

## Step 5: Save and clean up

```typescript theme={null}
await doc.save({ inPlace: true });
await doc.close();
await client.dispose();
```

## Full example

A complete, copy-pasteable script that opens a document, runs an agent, saves, and exits:

<Tabs>
  <Tab title="OpenAI">
    ```typescript theme={null}
    import OpenAI from 'openai';
    import {
      createSuperDocClient,
      chooseTools,
      dispatchSuperDocTool,
      getSystemPrompt,
    } from '@superdoc-dev/sdk';

    // 1. Open the document
    const client = createSuperDocClient();
    await client.connect();
    const doc = await client.open({ doc: './contract.docx' });

    // 2. Load tools and system prompt
    const { tools } = await chooseTools({ provider: 'openai' });
    const systemPrompt = await getSystemPrompt();

    // 3. Build the conversation
    const openai = new OpenAI();
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
    ];

    // 4. Agent loop
    while (true) {
      const response = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages,
        tools,
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
        console.log(choice.message.content);
        break;
      }

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;

        try {
          const result = await dispatchSuperDocTool(
            doc,
            toolCall.function.name,
            JSON.parse(toolCall.function.arguments),
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (err: any) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }
    }

    // 5. Save and clean up
    await doc.save({ inPlace: true });
    await doc.close();
    await client.dispose();
    ```
  </Tab>

  <Tab title="Anthropic">
    ```typescript theme={null}
    import Anthropic from '@anthropic-ai/sdk';
    import {
      createSuperDocClient,
      chooseTools,
      dispatchSuperDocTool,
      getSystemPrompt,
    } from '@superdoc-dev/sdk';

    // 1. Open the document
    const client = createSuperDocClient();
    await client.connect();
    const doc = await client.open({ doc: './contract.docx' });

    // 2. Load tools and system prompt
    const { tools } = await chooseTools({ provider: 'anthropic' });
    const systemPrompt = await getSystemPrompt();

    // 3. Build the conversation
    const anthropic = new Anthropic();
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
    ];

    // 4. Agent loop
    while (true) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });

      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn' || !response.content.some((b) => b.type === 'tool_use')) {
        const textBlock = response.content.find((b) => b.type === 'text');
        console.log(textBlock?.text);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        try {
          const result = await dispatchSuperDocTool(
            doc,
            block.name,
            block.input as Record<string, unknown>,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err: any) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // 5. Save and clean up
    await doc.save({ inPlace: true });
    await doc.close();
    await client.dispose();
    ```
  </Tab>

  <Tab title="Vercel AI">
    ```typescript theme={null}
    import { generateText, jsonSchema, stepCountIs } from 'ai';
    import { openai } from '@ai-sdk/openai';
    import {
      createSuperDocClient,
      chooseTools,
      dispatchSuperDocTool,
      getSystemPrompt,
    } from '@superdoc-dev/sdk';

    // 1. Open the document
    const client = createSuperDocClient();
    await client.connect();
    const doc = await client.open({ doc: './contract.docx' });

    // 2. Load tools and system prompt
    const { tools: sdkTools } = await chooseTools({ provider: 'vercel' });
    const systemPrompt = await getSystemPrompt();

    // 3. Convert SDK tools into Vercel AI tool objects
    const tools: Record<string, any> = {};
    for (const t of sdkTools as any[]) {
      const fn = t.function;
      tools[fn.name] = {
        description: fn.description,
        inputSchema: jsonSchema<Record<string, unknown>>(fn.parameters),
        execute: async (args: Record<string, unknown>) => {
          try {
            return await dispatchSuperDocTool(doc, fn.name, args);
          } catch (err: any) {
            return { error: err.message };
          }
        },
      };
    }

    // 4. Run the agent (loop handled by generateText)
    const { text } = await generateText({
      model: openai.chat('gpt-5.4'),
      system: systemPrompt,
      messages: [
        { role: 'user', content: 'Find the termination clause and rewrite it to allow 30-day notice.' },
      ],
      tools,
      stopWhen: stepCountIs(10),
    });

    console.log(text);

    // 5. Save and clean up
    await doc.save({ inPlace: true });
    await doc.close();
    await client.dispose();
    ```
  </Tab>
</Tabs>

## Other providers

### AWS Bedrock

Use `chooseTools({ provider: 'anthropic' })` and convert to Bedrock's `toolSpec` shape:

<Tabs>
  <Tab title="Node.js">
    ```typescript theme={null}
    import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
    import { createSuperDocClient, chooseTools, dispatchSuperDocTool } from '@superdoc-dev/sdk';

    const client = createSuperDocClient();
    await client.connect();
    const doc = await client.open({ doc: './contract.docx' });

    // Get tools in Anthropic format, convert to Bedrock toolSpec shape
    const { tools } = await chooseTools({ provider: 'anthropic' });
    const toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.input_schema },
        },
      })),
    };

    const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
    const messages = [
      { role: 'user', content: [{ text: 'Review this contract.' }] },
    ];

    while (true) {
      const res = await bedrock.send(new ConverseCommand({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        messages,
        system: [{ text: 'You edit .docx files using SuperDoc tools. Use tracked changes for all edits.' }],
        toolConfig,
      }));

      const output = res.output?.message;
      if (!output) break;
      messages.push(output);

      const toolUses = output.content?.filter((b) => b.toolUse) ?? [];
      if (!toolUses.length) break;

      const results = [];
      for (const block of toolUses) {
        const { name, input, toolUseId } = block.toolUse;
        const result = await dispatchSuperDocTool(doc, name, input ?? {});
        const json = typeof result === 'object' && result !== null ? result : { result };
        results.push({ toolResult: { toolUseId, content: [{ json }] } });
      }
      messages.push({ role: 'user', content: results });
    }

    await doc.save();
    await doc.close();
    await client.dispose();
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    import boto3
    from superdoc import SuperDocClient, choose_tools, dispatch_superdoc_tool

    client = SuperDocClient()
    client.connect()
    doc = client.open({"doc": "./contract.docx"})

    # Get tools in Anthropic format, convert to Bedrock toolSpec shape
    sd_tools = choose_tools({"provider": "anthropic"})
    tool_config = {
        "tools": [
            {
                "toolSpec": {
                    "name": t["name"],
                    "description": t["description"],
                    "inputSchema": {"json": t.get("input_schema", {})},
                }
            }
            for t in sd_tools["tools"]
        ]
    }

    bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
    messages = [{"role": "user", "content": [{"text": "Review this contract."}]}]

    while True:
        response = bedrock.converse(
            modelId="us.anthropic.claude-sonnet-4-6",
            messages=messages,
            system=[{"text": "You edit .docx files using SuperDoc tools. Use tracked changes for all edits."}],
            toolConfig=tool_config,
        )

        output = response["output"]["message"]
        messages.append(output)

        tool_uses = [b for b in output.get("content", []) if "toolUse" in b]
        if not tool_uses:
            break

        tool_results = []
        for block in tool_uses:
            tu = block["toolUse"]
            result = dispatch_superdoc_tool(doc, tu["name"], tu.get("input", {}))
            json_result = result if isinstance(result, dict) else {"result": result}
            tool_results.append(
                {"toolResult": {"toolUseId": tu["toolUseId"], "content": [{"json": json_result}]}}
            )
        messages.append({"role": "user", "content": tool_results})

    doc.save({})
    doc.close({})
    client.dispose()
    ```
  </Tab>
</Tabs>

**Auth**: AWS credentials via `aws configure`, env vars, or IAM role. No API key needed.

## Streaming generated text into a visible editor

Sometimes you don't need a full agent loop. You just want the model to write into the document while the user watches. Stream the output through a small backend proxy and append each delta to the editor:

```ts theme={null}
for await (const chunk of streamFromServer(prompt, signal)) {
  buffer += chunk;
  if (chunk.includes('\n')) flush();
  else if (!pendingFlush) pendingFlush = setTimeout(flush, 150);
}

function flush() {
  editor.doc.insert({ value: buffer, type: 'text' });
  buffer = '';
}
```

`editor.doc.insert` is the public Document API. With no `target`, content appends at the end. Newlines from the model become real paragraph breaks.

A few things to get right:

* **Keep the model key on the server.** A small Node proxy that forwards Server-Sent Events keeps the key out of client bundles.
* **Buffer deltas.** Inserting on every token causes one document mutation per token, which floods the layout engine and undo stack. Flush on a timer (\~150ms) or whenever a newline arrives.
* **Abort on unmount and Stop.** Tie an `AbortController` to the fetch and call it from your cleanup. The server should also abort upstream when the client disconnects so neither side burns tokens.

Full working example: [examples/ai/streaming](https://github.com/superdoc-dev/superdoc/tree/main/examples/ai/streaming).

## Related

* [LLM tools](/ai/agents/llm-tools): tool catalog and SDK functions
* [Best practices](/ai/agents/best-practices): prompting, workflow tips, and tested prompt examples
* [Debugging](/ai/agents/debugging): troubleshoot tool call failures
* [Collaboration](/editor/collaboration/overview): add real-time sync between agent and frontend
* [SDKs](/document-engine/sdks): typed Node.js and Python wrappers


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.superdoc.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Best practices

> Get better results from LLM document editing: prompting, tool call patterns, and workflow tips

These patterns help your LLM agent produce reliable, efficient document edits.

## Use the bundled system prompt

`getSystemPrompt()` returns a tested prompt that teaches the model how to use SuperDoc tools: targeting, workflow order, and multi-action tools. Load it once and pass it as the system message.

```typescript theme={null}
import { getSystemPrompt } from '@superdoc-dev/sdk';

const systemPrompt = await getSystemPrompt();
// Pass as the system message in your LLM call
```

You can extend it with task-specific instructions. Append your own rules after the bundled prompt:

```typescript theme={null}
const systemPrompt = await getSystemPrompt();
const fullPrompt = `${systemPrompt}\n\n## Additional rules\n- Use tracked changes for all edits.\n- Always search before editing.`;
```

Or start from scratch with something like this:

```markdown theme={null}
You edit `.docx` files using SuperDoc intent tools. Be efficient and minimize tool calls.

## Workflow

1. **Read**: Use `superdoc_get_content` to understand the document.
2. **Search**: Use `superdoc_search` to find stable handles or block addresses.
3. **Edit**: Use the focused tool that matches the job:
   - `superdoc_edit` for insert, replace, delete, undo, redo
   - `superdoc_format` for inline or paragraph formatting
   - `superdoc_create` for paragraphs and headings
   - `superdoc_comment` for comment threads
   - `superdoc_track_changes` for review decisions
4. **Batch only when useful**: Use `superdoc_mutations` for preview/apply or atomic multi-step edits.

## Rules

- Search before mutating so targets come from fresh results.
- Use focused intent tools for normal edits.
- Use `superdoc_mutations` when you need an atomic batch or preview/apply flow.
- Set `changeMode: "tracked"` when edits need human review.
- Feed tool errors back so you can recover.
```

## Read first, search, then edit

A typical edit takes 3-5 tool calls:

1. `superdoc_get_content`: understand what's in the document
2. `superdoc_search`: find the exact location (returns stable handles/addresses)
3. Edit tool (`superdoc_edit`, `superdoc_format`, etc.): apply the change using targets from search

This matters because handles from search results point to the exact right location. If the model guesses a block address instead of searching for it, edits land in the wrong place.

## Minimize tool calls

Instruct the LLM to plan all edits before calling tools. A well-structured prompt like "Find the termination clause and rewrite it to allow 30-day notice" should take 3-5 calls, not 15.

Batch multiple changes only when atomic execution is genuinely helpful: use `superdoc_mutations` for that.

## Prefer markdown insert for multi-block creation

When you need to create multiple headings and paragraphs in one operation, use `superdoc_edit` with `type: "markdown"` instead of calling `superdoc_create` once per block. A single markdown insert produces the entire structure in one call.

```json theme={null}
{
  "action": "insert",
  "type": "markdown",
  "value": "## Executive Summary\n\nThis agreement governs the terms of service.\n\n## Key Provisions\n\nThe following provisions apply to all parties."
}
```

After inserting, apply formatting in a single `superdoc_mutations` batch using `format.apply` steps: one step per block or range. This reduces a workflow that might otherwise take 40+ calls down to 4: read, search, insert, format.

## Use focused tools: `superdoc_mutations` is an escape hatch

For straightforward edits, use the focused intent tools (`superdoc_edit`, `superdoc_format`, `superdoc_create`, `superdoc_list`, `superdoc_comment`). They validate arguments, give clear errors, and are easier for models to call correctly.

Reach for `superdoc_mutations` only when you need:

* Preview/apply semantics (show what will change before committing)
* Atomic multi-step edits (all-or-nothing batch)
* A workflow that would otherwise require refreshing targets between steps

## Feed errors back

`dispatchSuperDocTool` returns structured errors. Pass them back as tool results: most models self-correct on the next turn.

```typescript theme={null}
try {
  const result = await dispatchSuperDocTool(doc, toolCall.function.name, JSON.parse(toolCall.function.arguments));
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
} catch (err: any) {
  // Return the error as a tool result: the model will see it and adjust
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
}
```

## Choose formatting values from the document

Don't hardcode formatting values. Read them from the document's existing content and match what's already there.

**Body text:** Read `fontFamily`, `fontSize`, and `color` from non-empty paragraphs with `alignment: "justify"` or `alignment: "left"`. Set `bold: false` for body paragraphs.

Many DOCX documents report `underline: true` on all blocks due to style inheritance. This is a DOCX artifact: not intentional formatting. Do not carry it forward when inserting new paragraphs.

**Headings:** Read from existing heading blocks in the document. Scale `fontSize` up relative to body text. Headings are typically bold and sometimes centered: confirm against what's already in the document rather than assuming.

```typescript theme={null}
// Get content first, find a representative body paragraph
const content = await superdoc.getContent();
const bodyParagraph = content.blocks.find(
  (b) => b.type === 'paragraph' && b.text?.trim().length > 0
);
const { fontFamily, fontSize, color } = bodyParagraph?.formatting ?? {};

// Use those values when formatting inserted content
```

## Add examples for repeatable workflows

If the same kind of edit runs across many documents (e.g., always rewriting a specific clause, always adding a comment to a section), include a concrete tool call example in your system prompt. Models that see a working example of the exact tool invocation produce correct calls more reliably than models that only see the schema.

## Use tracked changes for review workflows

Add `changeMode: "tracked"` to edit tool calls, or instruct the model via the system prompt:

```
Use tracked changes for all edits so a human can review them.
```

This way every AI edit appears as a tracked change that users can accept or reject in SuperDoc or Microsoft Word.

## Pin your model version

Use a specific model ID (e.g., `gpt-4.1` or `claude-sonnet-4-6`) rather than an alias like `gpt-4o`. Aliases can change behavior between releases and break working tool call patterns.

## Cache tools and prompts

Tools and the system prompt don't change between requests. Load them once at startup and reuse across all conversations.

```typescript theme={null}
let cachedTools: any[] | null = null;
let cachedSystemPrompt: string | null = null;

async function ensureToolsLoaded() {
  if (!cachedTools) {
    const result = await chooseTools({ provider: 'openai' });
    cachedTools = result.tools;
  }
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = await getSystemPrompt();
  }
  return { tools: cachedTools, systemPrompt: cachedSystemPrompt };
}
```

## Prompt examples

These prompts have been tested against the SuperDoc tool set. Use them as inspiration for your own workflows, or include them as few-shot examples in your system prompt.

### Document review

* "Find the termination clause and rewrite it to require 30-day written notice. Use tracked changes."
* "Apply yellow highlight to every sentence that contains an indemnification obligation."
* "Replace all references to 'Contractor' with 'Service Provider' and make each replacement italic with tracked changes enabled."
* "Underline every sentence that references payment terms or late fees."
* "Insert CONFIDENTIAL: DO NOT DISTRIBUTE at the very top of the document and make it bold, red, 14pt."
* "Scan the document for inconsistent capitalization of defined terms and fix them with tracked changes enabled."

### Formatting and structure

* "Format the entire document in Times New Roman, 12-point."
* "Make all Heading 2 paragraphs bold and set them to 14-point font."
* "Keep each section heading with the paragraph that follows it so they don't split across pages."
* "Remove all extra blank paragraphs and convert all double spaces after periods to single spaces."
* "Right-align all section headings."

### Content generation and editing

* "Add a new heading 'Learning Objectives' at the top, followed by a bullet list with 3 key takeaways from the document content."
* "Read the document and add a heading 'Executive Summary' at the end, followed by a one-paragraph summary and a bullet list of the 5 key provisions."
* "Find the governing law section and insert a new paragraph after it: 'Any disputes arising under this Agreement shall be resolved through binding arbitration.'"
* "Find all paragraphs that mention 'personally identifiable information' and add a comment: 'Verify PII handling complies with current data retention policy.'"
* "Convert the list of references at the end into a numbered list and restart numbering at 1."

### Search and replace

* "Rewrite all dates in this document in the format January 1, 2026."
* "Replace every occurrence of 'FY2024' with 'FY2025' throughout the document."
* "Add the § symbol before every section number reference."

## Related

* [LLM tools](/ai/agents/llm-tools): tool catalog and SDK functions
* [How to use](/ai/agents/integrations): step-by-step integration guide
* [Debugging](/ai/agents/debugging): troubleshoot tool call failures
* [Document API](/document-api/overview): the operation set behind the tools


> ## Documentation Index
> Fetch the complete documentation index at: https://docs.superdoc.dev/llms.txt
> Use this file to discover all available pages before exploring further.

# Debugging

> Troubleshoot LLM tool calls: logging, error shapes, and common failure modes

When tool calls fail or produce unexpected results, use these patterns to diagnose the issue.

## LLM tools wrap the Document API

Every LLM tool call maps to a [Document API](/document-api/overview) operation under the hood. `superdoc_edit` with `action: "replace"` calls the same function as `doc.replace()`.

This gives you a clear debugging strategy:

1. **Test the Document API directly.** Call the underlying SDK method with the same arguments. If it works, the operation is fine: the problem is in the prompt or the tool schema.
2. **If the API call fails,** the issue is in the operation itself: check arguments, targets, and document state.
3. **If the API call succeeds but the LLM tool call fails,** the model is calling the tool incorrectly. Fix the prompt, add examples, or check the tool schema.

```typescript theme={null}
// Instead of going through the LLM, test the operation directly:
const result = await doc.replace({
  target: { handle: 'some-handle' },
  content: 'New text',
});
console.log(result); // Does this work?
```

This narrows every issue to one of two layers: the operation or the prompt.

## Log tool calls and results

Add logging around `dispatchSuperDocTool` to see exactly what the model is requesting and what comes back.

```typescript theme={null}
for (const toolCall of choice.message.tool_calls) {
  const args = JSON.parse(toolCall.function.arguments);

  // Log what the model wants to do
  console.log(`[agent] tool: ${toolCall.function.name}`, JSON.stringify(args, null, 2));

  try {
    const result = await dispatchSuperDocTool(doc, toolCall.function.name, args);

    // Log the result (truncate large responses)
    const resultStr = JSON.stringify(result);
    console.log(`[agent] result: ${resultStr.substring(0, 500)}`);

    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultStr });
  } catch (err: any) {
    console.error(`[agent] error: ${err.message}`);
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: err.message }) });
  }
}
```

What to look for in logs:

* **Tool name**: is the model calling the right tool?
* **Arguments**: are required fields present? Is the `action` correct?
* **Targets**: are handles/addresses from a recent search, or did the model guess?
* **Result**: did the operation return data or an error?

## Error shapes

`dispatchSuperDocTool` throws errors in two categories:

**Validation errors**: bad arguments before the operation runs:

```json theme={null}
{ "error": "Missing required parameter: action" }
{ "error": "Unknown action 'bold' for tool superdoc_format. Valid actions: inline, set_style, set_alignment, set_indentation, set_spacing" }
{ "error": "Parameter 'target' is required for action 'replace'" }
```

**Execution errors**: the operation ran but failed:

```json theme={null}
{ "error": "Target not found: no node matches the given handle" }
{ "error": "Invalid address: block at index 42 does not exist" }
```

Both types are returned as strings in `err.message`. Pass them back as tool results: the model usually self-corrects.

## Common failure modes

| Symptom                                    | Cause                                   | Fix                                                       |
| ------------------------------------------ | --------------------------------------- | --------------------------------------------------------- |
| Model calls the wrong tool                 | System prompt missing or too vague      | Use `getSystemPrompt()` or add workflow instructions      |
| "Target not found" errors                  | Model uses stale or guessed handles     | Instruct model to always search before editing            |
| Edits land in the wrong place              | Model invented a block address          | Use `superdoc_search` to get fresh handles                |
| Infinite tool call loop                    | Model never reaches a stopping point    | Add a max iterations guard (see below)                    |
| Model doesn't use tools at all             | Tools not passed to the API call        | Verify `chooseTools()` result is in the `tools` param     |
| "Missing required parameter"               | Model forgot `action` or another field  | Check the tool schema: add examples to the prompt         |
| Collaboration edits not appearing          | SDK not in the same collab room         | Verify the collaboration URL and documentId match         |
| Operation works via API but fails via tool | Model passes wrong argument types/names | Log the parsed arguments and compare to the API signature |

## Inspect tools directly

Dump the tool schemas to verify the SDK loaded correctly:

```typescript theme={null}
import { listTools, getToolCatalog } from '@superdoc-dev/sdk';

// See all tools for a provider
const tools = await listTools('openai');
console.log(JSON.stringify(tools, null, 2));

// Get the full catalog with metadata
const catalog = await getToolCatalog();
console.log(`Loaded ${catalog.tools.length} tools`);
```

## Max iterations guard

Prevent runaway loops by capping the number of iterations:

```typescript theme={null}
const MAX_ITERATIONS = 20;
let iterations = 0;

while (iterations++ < MAX_ITERATIONS) {
  const response = await openai.chat.completions.create({ model, messages, tools });
  const message = response.choices[0].message;
  messages.push(message);

  if (!message.tool_calls?.length) break;

  for (const call of message.tool_calls) {
    const result = await dispatchSuperDocTool(doc, call.function.name, JSON.parse(call.function.arguments));
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

if (iterations >= MAX_ITERATIONS) {
  console.warn('[agent] Hit max iterations: stopping');
}
```

## Related

* [LLM tools](/ai/agents/llm-tools): tool catalog and SDK functions
* [How to use](/ai/agents/integrations): step-by-step integration guide
* [Best practices](/ai/agents/best-practices): prompting and workflow tips
* [Document API](/document-api/overview): the underlying operations that tools call


