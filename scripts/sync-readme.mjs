import fs from "fs";

// Check registered tools count and resource count
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectTools } from "../build/tools/connect.js";
import { registerPageTools } from "../build/tools/page.js";
import { registerNetworkTools } from "../build/tools/network.js";
import { registerProfileTools } from "../build/tools/profile.js";
import { registerMainTools } from "../build/tools/main.js";
import { registerScriptTools } from "../build/tools/script.js";
import { registerPrompts } from "../build/tools/prompts.js";
import { registerResources } from "../build/tools/resources.js";

const server = new McpServer({ name: "test", version: "1.0.0" });
registerConnectTools(server, { notifyResourceListChanged: async () => {} });
registerPageTools(server);
registerNetworkTools(server);
registerProfileTools(server);
registerMainTools(server);
registerScriptTools(server);
registerPrompts(server);
registerResources(server);

const toolCount = Object.keys(server._registeredTools || {}).length;
const promptCount = Object.keys(server._registeredPrompts || {}).length;
const resourceCount =
	Object.keys(server._registeredResources || {}).length +
	Object.keys(server._registeredResourceTemplates || {}).length;

console.log(
	`Discovered: ${toolCount} tools, ${resourceCount} resources, ${promptCount} prompts`
);

let readme = fs.readFileSync("README.md", "utf8");

// Update badges
readme = readme.replace(
	/<img alt="\d+[ _]tools" src="https:\/\/img\.shields\.io\/badge\/\d+_tools-[^"]+" \/>/,
	`<img alt="${toolCount} tools" src="https://img.shields.io/badge/${toolCount}_tools-0F766E?style=flat-square" />`
);
readme = readme.replace(
	/<img alt="\d+[ _]resources" src="https:\/\/img\.shields\.io\/badge\/\d+_resources-[^"]+" \/>/,
	`<img alt="${resourceCount} resources" src="https://img.shields.io/badge/${resourceCount}_resources-115E59?style=flat-square" />`
);
readme = readme.replace(
	/<img alt="\d+[ _]prompts" src="https:\/\/img\.shields\.io\/badge\/\d+_prompts-[^"]+" \/>/,
	`<img alt="${promptCount} prompts" src="https://img.shields.io/badge/${promptCount}_prompts-134E4A?style=flat-square" />`
);

if (!readme.includes("electron://artifacts")) {
	readme = readme.replace(
		"| `electron://cdp/{processId}/{targetId}` | One target. |",
		"| `electron://cdp/{processId}/{targetId}` | One target. |\n| `electron://artifacts` | All exported screenshots, traces, heap snapshots, HARs, PDFs. |\n| `electron://artifact/{id}` | Read an exported artifact file by its unique artifact ID. |"
	);
}

fs.writeFileSync("README.md", readme, "utf8");
console.log("README.md updated with verified capability counts.");
